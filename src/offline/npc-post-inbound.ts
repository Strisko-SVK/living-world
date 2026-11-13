import { z } from "zod";
import type { OfflineWorkflowResult } from "./npc-e2e.js";
import type {
  SceneHandshakeDependencies,
  SceneInteraction,
  SceneRequest,
} from "./npc-scene-handshake.js";

// A persisted, already-accepted Discord event can be resumed without
// re-entering intake (which correctly returns "duplicate"). This port is
// test-only; it never reads the Gateway, grants presence, or sends a message.
const sourceSchema = z
  .object({
    worldId: z.string().uuid(),
    contextId: z.string().uuid(),
    sourceMessageId: z.string().regex(/^\d{17,20}$/u),
    guildId: z.string().regex(/^\d{17,20}$/u),
    channelId: z.string().regex(/^\d{17,20}$/u),
    threadId: z.string().regex(/^\d{17,20}$/u).nullable(),
    authorId: z.string().regex(/^\d{17,20}$/u),
  })
  .strict();

const requestSchema = z
  .object({
    source: sourceSchema,
    npcId: z.string().uuid(),
    interactionId: z.string().uuid(),
  })
  .strict();

export type PersistedContinuationRequest = z.infer<typeof requestSchema>;
export type PersistedContinuationResult =
  | "offline_only"
  | "invalid_request"
  | "not_found"
  | "ambiguous_event"
  | "invalid_binding"
  | "no_presence"
  | "presence_denied"
  | "workflow_uncertain"
  | OfflineWorkflowResult;

export type PersistedContinuationDependencies = Omit<
  SceneHandshakeDependencies,
  "intake"
> & {
  // Fixed-category, privacy-safe outcome only. No IDs, content or errors.
  diagnose?: (event: {
    event: "npc_post_inbound";
    outcome: PersistedContinuationResult;
  }) => void;
};

function matchesPersistedEvent(
  interaction: SceneInteraction,
  source: SceneRequest,
  request: PersistedContinuationRequest,
): boolean {
  return (
    interaction.id === request.interactionId &&
    interaction.npcId === request.npcId &&
    interaction.worldId === source.worldId &&
    interaction.contextId === source.contextId &&
    interaction.sourceProvider === "discord" &&
    interaction.sourceMessageId === source.sourceMessageId &&
    interaction.sourceGuildId === source.guildId &&
    interaction.sourceChannelId === source.channelId &&
    interaction.sourceThreadId === source.threadId &&
    !!interaction.sourceMappingId &&
    z.string().uuid().safeParse(interaction.sourceMappingId).success &&
    !!interaction.speakerEntityId &&
    z.string().uuid().safeParse(interaction.speakerEntityId).success &&
    interaction.status === "received" &&
    interaction.communicationMode === "unknown" &&
    interaction.localPresenceId === null
  );
}

export function createOfflinePersistedContinuation(
  deps: PersistedContinuationDependencies,
) {
  return async (input: PersistedContinuationRequest): Promise<PersistedContinuationResult> => {
    const finish = (outcome: PersistedContinuationResult) => {
      try {
        deps.diagnose?.({ event: "npc_post_inbound", outcome });
      } catch {
        // Diagnostics must never change authorization or delivery outcomes.
      }
      return outcome;
    };
    if (
      process.env.NODE_ENV !== "test" ||
      process.env.DISCORD_ENABLED === "true" ||
      process.env.DISCORD_OUTBOUND_ENABLED === "true" ||
      process.env.LLM_PROVIDER === "openai"
    )
      return finish("offline_only");

    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return finish("invalid_request");
    const request = parsed.data;
    let responseStarted = false;
    try {
      // Caller-provided IDs cannot authorize anything. The received() port
      // MUST query the authoritative DB by original event and mapped author;
      // each returned row is compared to the exact immutable source route.
      const matches = await deps.received(request.source);
      if (matches.length === 0) return finish("not_found");
      if (matches.length !== 1) return finish("ambiguous_event");
      const interaction = matches[0]!;
      if (!matchesPersistedEvent(interaction, request.source, request))
        return finish("invalid_binding");

      // Local evidence comes only from the trusted DB. The existing
      // prepareLocalInteraction transaction revalidates its issue time,
      // revocation, scene policy, NPC state/version and source event.
      const evidenceId = await deps.presence(interaction);
      if (!evidenceId || !z.string().uuid().safeParse(evidenceId).success)
        return finish("no_presence");
      if ((await deps.prepare(interaction, evidenceId)) !== "prepared")
        return finish("presence_denied");

      // respond() MUST use the existing fake-only, disposable-world harness,
      // which re-reads the prepared interaction and preserves route/ACK fences.
      responseStarted = true;
      return finish(await deps.respond(interaction));
    } catch {
      // Never retry after an uncertain fake generation/delivery outcome.
      return finish(responseStarted ? "workflow_uncertain" : "presence_denied");
    }
  };
}
