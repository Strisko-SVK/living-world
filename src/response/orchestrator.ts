import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PROMPT_VERSION,
  type ResponseDependencies,
  type ResponseDiagnostic,
  type ResponseOptions,
  type ResponseResult,
  type ResponseScope,
} from "./contracts.js";
import { filterResponseContext, VisibilityBlocked } from "./visibility.js";
import { composeResponsePrompt, validateNpcSpeech } from "./prompt.js";

const scopeSchema = z.object({
  worldId: z.string().uuid(),
  npcId: z.string().uuid(),
  interactionId: z.string().uuid(),
});
const optionsSchema = z.object({
  maxResponseChars: z.number().int().min(1).max(20_000).default(2000),
  maxOutputTokens: z.number().int().positive().optional(),
  requestBudgetMicros: z.number().int().positive().safe().optional(),
});
export function createNpcResponseOrchestrator(
  deps: ResponseDependencies,
  diagnose: (event: ResponseDiagnostic) => void = () => {},
) {
  return async (
    worldId: string,
    npcId: string,
    interactionId: string,
    options: ResponseOptions = {},
  ): Promise<ResponseResult> => {
    const scope: ResponseScope = { worldId, npcId, interactionId };
    const parsed = optionsSchema.safeParse(options);
    let traceId: string = randomUUID(),
      claimId: string | null = null,
      dispatched = false;
    const finish = (result: ResponseResult): ResponseResult => {
      try {
        diagnose({
          event: "npc_response",
          traceId,
          promptVersion: PROMPT_VERSION,
          outcome: result.ok ? result.status : result.error,
        });
      } catch {
        /* isolated */
      }
      return result;
    };
    if (!scopeSchema.safeParse(scope).success || !parsed.success)
      return finish({ ok: false, error: "invalid_request" });
    try {
      const current = await deps.read(scope);
      if (
        !current ||
        current.worldId !== worldId ||
        current.npcId !== npcId ||
        current.id !== interactionId
      )
        return finish({ ok: false, error: "not_found" });
      traceId = current.traceId;
      if (
        current.responseText !== null &&
        ["responded", "completed"].includes(current.status)
      )
        return finish({
          ok: true,
          status: "already_recorded",
          interaction: current,
          promptVersion: current.responsePromptVersion,
        });
      if (
        current.status !== "received" ||
        current.responseText !== null ||
        current.responseClaimId !== null
      )
        return finish({ ok: false, error: "ineligible" });
      if (options.signal?.aborted)
        return finish({ ok: false, error: "cancelled" });
      let context;
      try {
        context = await deps.build({
          ...options.context,
          ...scope,
          limits: { ...options.context?.limits, history: 0 },
        });
      } catch {
        return finish({ ok: false, error: "context_unavailable" });
      }
      let permitted;
      try {
        permitted = filterResponseContext(context, current);
      } catch (error) {
        return finish({
          ok: false,
          error:
            error instanceof VisibilityBlocked
              ? "visibility_blocked"
              : "context_unavailable",
        });
      }
      let prompt;
      try {
        prompt = composeResponsePrompt(permitted, parsed.data.maxResponseChars);
      } catch {
        return finish({ ok: false, error: "context_unavailable" });
      }
      if (options.signal?.aborted)
        return finish({ ok: false, error: "cancelled" });
      const claim = await deps.store.claim(scope, current);
      if (!claim?.responseClaimId)
        return finish({ ok: false, error: "ineligible" });
      claimId = claim.responseClaimId;
      if (options.signal?.aborted) {
        await deps.store.fail(scope, claimId, false);
        return finish({ ok: false, error: "cancelled" });
      }
      if (!(await deps.store.dispatch(scope, claimId))) {
        await deps.store.fail(scope, claimId, false);
        return finish({ ok: false, error: "claim_lost" });
      }
      dispatched = true;
      const generated = await deps.generate({
        traceId,
        ...prompt,
        signal: options.signal,
        maxOutputTokens: parsed.data.maxOutputTokens,
        requestBudgetMicros: parsed.data.requestBudgetMicros,
      });
      if (!generated.ok) {
        await deps.store.fail(
          scope,
          claimId,
          generated.observation.costKind === "conservative_reservation",
        );
        return finish({
          ok: false,
          error: "generation_failed",
          providerError: generated.error,
        });
      }
      const speech = validateNpcSpeech(
        generated.text,
        parsed.data.maxResponseChars,
        permitted.excludedText,
      );
      if (!speech) {
        await deps.store.fail(scope, claimId, false);
        return finish({ ok: false, error: "invalid_response" });
      }
      const saved = await deps.store.persist(scope, claimId, speech);
      if (!saved) {
        await deps.store.fail(scope, claimId, true);
        return finish({ ok: false, error: "claim_lost" });
      }
      return finish({
        ok: true,
        status: "responded",
        interaction: saved,
        promptVersion: PROMPT_VERSION,
      });
    } catch {
      // Persistence can commit even when the caller loses the acknowledgement.
      // Inspect first; never try an illegal responded -> failed transition.
      if (claimId) {
        try {
          const persisted = await deps.read(scope);
          if (
            persisted &&
            persisted.responseText !== null &&
            persisted.id === interactionId &&
            persisted.worldId === worldId &&
            persisted.npcId === npcId &&
            ["responded", "completed"].includes(persisted.status)
          )
            return finish({
              ok: true,
              status: "already_recorded",
              interaction: persisted,
              promptVersion: persisted.responsePromptVersion,
            });
          await deps.store.fail(scope, claimId, dispatched);
        } catch {
          /* durable claim remains for explicit stale reconciliation */
        }
      }
      return finish({ ok: false, error: "persistence" });
    }
  };
}
