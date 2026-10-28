import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import type { LlmConfig } from "./config.js";
import {
  ProviderFailure,
  type BudgetStore,
  type GenerationRequest,
  type GenerationResult,
  type Observation,
  type ProviderRequest,
  type TextProvider,
  type Usage,
} from "./contracts.js";

const requestSchema = z.object({
  traceId: z.string().uuid(),
  model: z.string().optional(),
  instructions: z.object({
    system: z.string().trim().min(1).max(100_000),
    developer: z.string().max(100_000).optional(),
  }),
  messages: z
    .array(
      z.object({
        role: z.literal("user"),
        content: z.string().min(1).max(100_000),
      }),
    )
    .min(1)
    .max(32),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  responseFormat: z
    .object({
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      schema: z.record(z.string(), z.unknown()),
    })
    .strict()
    .optional(),
  requestBudgetMicros: z.number().int().positive().safe().optional(),
});
export const tokenCost = (
  input: number,
  output: number,
  inputRate: bigint,
  outputRate: bigint,
) =>
  (BigInt(input) * inputRate + BigInt(output) * outputRate + 999_999n) /
  1_000_000n;

function interruptible<T>(
  run: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProviderFailure("cancelled"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(run)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export function createTextGenerator(
  config: LlmConfig,
  provider: TextProvider,
  budget: BudgetStore,
  diagnose: (value: Observation) => void = () => {},
) {
  return async (request: GenerationRequest): Promise<GenerationResult> => {
    const started = performance.now();
    const parsed = requestSchema.safeParse(request);
    const traceId = parsed.success ? parsed.data.traceId : randomUUID();
    const observation: Observation = {
      traceId,
      provider: config.enabled ? config.provider : "disabled",
      model: config.enabled ? config.model : "unconfigured",
      outcome: "invalid_request",
      retries: 0,
      latencyMs: 0,
      usage: null,
      currency: config.enabled ? config.currency : "unconfigured",
      costMicros: null,
      costKind: "none",
      estimateExceeded: false,
    };
    const finish = (ok: boolean, text = ""): GenerationResult => {
      observation.latencyMs = Math.round(performance.now() - started);
      // Diagnostic failures must never trigger a duplicate generation.
      try {
        diagnose({ ...observation });
      } catch {
        /* intentionally isolated */
      }
      return ok
        ? { ok: true, text, observation }
        : {
            ok: false,
            error:
              observation.outcome === "success"
                ? "accounting"
                : observation.outcome,
            observation,
          };
    };
    if (!config.enabled) {
      observation.outcome = "disabled";
      return finish(false);
    }
    if (!parsed.success) return finish(false);
    const data = parsed.data;
    if (data.responseFormat && provider.supportsStructuredOutput !== true) {
      observation.outcome = "unsupported_output";
      return finish(false);
    }
    if (
      (data.model && data.model !== config.model) ||
      (data.maxOutputTokens && data.maxOutputTokens > config.maxOutputTokens)
    )
      return finish(false);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    const cancel = () => controller.abort();
    request.signal?.addEventListener("abort", cancel, { once: true });
    if (request.signal?.aborted) cancel();
    const signal = controller.signal;
    const check = () => {
      if (signal.aborted)
        throw new ProviderFailure(timedOut ? "timeout" : "cancelled");
    };
    let id: string | undefined,
      charged = 0n,
      uncertain = false;
    let knownUsage: Usage | null = null;
    let reservation = 0n;
    let attempted = 0;
    let requestId: string | undefined;
    let text = "";
    let success = false;
    try {
      check();
      const input: ProviderRequest = {
        model: config.model,
        messages: [
          { role: "system", content: data.instructions.system },
          ...(data.instructions.developer
            ? [
                {
                  role: "developer" as const,
                  content: data.instructions.developer,
                },
              ]
            : []),
          ...data.messages,
        ],
        maxOutputTokens: data.maxOutputTokens ?? config.maxOutputTokens,
        temperature: data.temperature,
        ...(data.responseFormat ? { responseFormat: data.responseFormat } : {}),
      };
      if (
        request.beforeAttempt &&
        !(await interruptible(request.beforeAttempt, signal))
      )
        throw new ProviderFailure("cancelled", false, undefined, true);
      check();
      const inputTokens = await interruptible(
        () => provider.countInput(input, signal),
        signal,
      );
      if (
        !Number.isSafeInteger(inputTokens) ||
        inputTokens < 0 ||
        inputTokens > 2_000_000_000
      )
        throw new ProviderFailure("invalid_response");
      const perAttempt = tokenCost(
        inputTokens,
        input.maxOutputTokens,
        config.inputRate,
        config.outputRate,
      );
      reservation = perAttempt * BigInt(config.maxAttempts);
      const requested =
        data.requestBudgetMicros === undefined
          ? undefined
          : BigInt(data.requestBudgetMicros);
      if (
        (config.requestMicros !== undefined &&
          reservation > config.requestMicros) ||
        (requested !== undefined && reservation > requested)
      )
        throw new ProviderFailure("budget");
      check();
      const candidate = randomUUID();
      if (
        !(await budget.reserve({
          id: candidate,
          traceId,
          provider: config.provider,
          model: config.model,
          currency: config.currency,
          ceiling: config.monthlyMicros,
          reserved: reservation,
          inputRate: config.inputRate,
          outputRate: config.outputRate,
        }))
      )
        throw new ProviderFailure("budget");
      id = candidate;
      observation.reservationMicros = reservation.toString();
      for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
        check();
        if (
          request.beforeAttempt &&
          !(await interruptible(request.beforeAttempt, signal))
        )
          throw new ProviderFailure("cancelled", false, undefined, true);
        check();
        observation.retries = attempt;
        attempted++;
        try {
          const reply = await interruptible(
            () => provider.generate(input, signal),
            signal,
          );
          if (
            reply.requestId &&
            /^req_[a-zA-Z0-9_-]{1,180}$/.test(reply.requestId)
          )
            requestId = reply.requestId;
          if (reply.usage) {
            const u = reply.usage;
            if (
              ![u.inputTokens, u.outputTokens, u.totalTokens].every(
                (n) => Number.isSafeInteger(n) && n >= 0 && n <= 2_000_000_000,
              ) ||
              u.totalTokens !== u.inputTokens + u.outputTokens
            )
              throw new ProviderFailure("invalid_response");
            const actual = tokenCost(
              u.inputTokens,
              u.outputTokens,
              config.inputRate,
              config.outputRate,
            );
            charged += actual;
            observation.estimateExceeded ||= actual > perAttempt;
            knownUsage = u;
          } else {
            charged += perAttempt;
            uncertain = true;
          }
          text = reply.text;
          observation.outcome =
            reply.completed &&
            typeof text === "string" &&
            text.trim() &&
            (!reply.usage ||
              (reply.usage.inputTokens === inputTokens &&
                reply.usage.outputTokens <= input.maxOutputTokens))
              ? "success"
              : "invalid_response";
          success = observation.outcome === "success";
          break;
        } catch (error) {
          const failure =
            error instanceof ProviderFailure
              ? error
              : new ProviderFailure("unavailable");
          if (!failure.definitelyUnbilled) {
            charged += perAttempt;
            uncertain = true;
          }
          observation.outcome = signal.aborted
            ? timedOut
              ? "timeout"
              : "cancelled"
            : failure.code;
          if (
            !failure.retryable ||
            signal.aborted ||
            attempt + 1 >= config.maxAttempts
          )
            break;
          const delay = Math.max(250 * 2 ** attempt, failure.retryAfterMs ?? 0);
          // Never retry earlier than provider guidance; stop instead if it exceeds
          // the bounded backoff/remaining request deadline.
          if (
            delay > 5000 ||
            performance.now() - started + delay >= config.timeoutMs
          )
            break;
          await interruptible(
            () => pause(delay, undefined, { signal }),
            signal,
          );
        }
      }
    } catch (error) {
      observation.outcome = signal.aborted
        ? timedOut
          ? "timeout"
          : "cancelled"
        : error instanceof ProviderFailure
          ? error.code
          : "accounting";
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", cancel);
    }
    observation.usage = knownUsage;
    if (id)
      observation.reservationOverageMicros = (
        charged > reservation ? charged - reservation : 0n
      ).toString();
    if (id) {
      observation.costMicros = charged.toString();
      observation.costKind = uncertain
        ? "conservative_reservation"
        : "estimated_from_usage";
      try {
        await budget.settle(id, {
          charged,
          uncertain,
          usage: knownUsage,
          outcome: observation.outcome,
          retries: Math.max(0, attempted - 1),
          latencyMs: Math.round(performance.now() - started),
          requestId,
        });
      } catch {
        // Original full reservation remains durable; never emit unaccounted text.
        observation.outcome = "accounting";
        success = false;
        observation.costMicros = (
          charged > reservation ? charged : reservation
        ).toString();
        observation.costKind = "conservative_reservation";
      }
    }
    return finish(success, text);
  };
}
