import { z } from "zod";
import type { OfflineWorkflowResult } from "./npc-e2e.js";

// Offline-only coordination of existing trusted database boundaries.
// This module never grants presence, interprets DM roles, logs into Discord,
// creates a provider, or sends a message.
const requestSchema = z
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
export type SceneRequest = z.infer<typeof requestSchema>;

export type SceneInteraction = {
  id: string;
  worldId: string;
  contextId: string;
  npcId: string;
  speakerEntityId: string | null;
  sourceProvider: string | null;
  sourceMessageId: string | null;
  sourceGuildId: string | null;
  sourceChannelId: string | null;
  sourceThreadId: string | null;
  sourceMappingId: string | null;
  communicationMode: string;
  localPresenceId: string | null;
  status: string;
};

export type SceneHandshakeDependencies = {
  // The actual M2.8 intake must authenticate Discord bot mention, scene,
  // author mapping, world/policy and unique NPC target transactionally.
  intake(request: SceneRequest): Promise<string>;
  // DB read by immutable world + source event identity, never alias alone.
  received(request: SceneRequest): Promise<readonly SceneInteraction[]>;
  // Trusted DB operator evidence only; never create it from the message.
  presence(interaction: SceneInteraction): Promise<string | null>;
  // Existing M2.9 transaction must revalidate evidence, source-time and policy.
  prepare(
    interaction: SceneInteraction,
    evidenceId: string,
  ): Promise<string>;
  // Existing M2.12 fake-only harness rechecks routing before fake delivery.
  respond(interaction: SceneInteraction): Promise<OfflineWorkflowResult>;
};

export type SceneHandshakeResult =
  | "offline_only"
  | "invalid_request"
  | "intake_denied"
  | "duplicate"
  | "ambiguous_event"
  | "invalid_binding"
  | "no_presence"
  | "presence_denied"
  | OfflineWorkflowResult;

// This is a test-only entrypoint, not an HTTP endpoint or a live Gateway hook.
// The composition root is responsible for using actual repository ports,
// disposable PG worlds, and fake provider/transport; this coordinator is not a
// substitute for those controls.
export function createOfflineSceneHandshake(deps: SceneHandshakeDependencies) {
  return async (input: SceneRequest): Promise<SceneHandshakeResult> => {
    if (process.env.NODE_ENV !== "test") return "offline_only";
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return "invalid_request";
    const request = parsed.data;
    try {
      const intake = await deps.intake(request);
      if (intake === "duplicate") return "duplicate";
      if (intake !== "accepted") return "intake_denied";

      const matches = await deps.received(request);
      if (matches.length !== 1) return "ambiguous_event";
      const interaction = matches[0]!;
      if (
        !z.string().uuid().safeParse(interaction.id).success ||
        !z.string().uuid().safeParse(interaction.npcId).success ||
        interaction.worldId !== request.worldId ||
        interaction.contextId !== request.contextId ||
        interaction.sourceProvider !== "discord" ||
        interaction.sourceMessageId !== request.sourceMessageId ||
        interaction.sourceGuildId !== request.guildId ||
        interaction.sourceChannelId !== request.channelId ||
        interaction.sourceThreadId !== request.threadId ||
        !interaction.sourceMappingId ||
        !z.string().uuid().safeParse(interaction.sourceMappingId).success ||
        !interaction.speakerEntityId ||
        !z.string().uuid().safeParse(interaction.speakerEntityId).success ||
        interaction.communicationMode !== "unknown" ||
        interaction.localPresenceId !== null ||
        interaction.status !== "received"
      )
        return "invalid_binding";

      const evidenceId = await deps.presence(interaction);
      if (!evidenceId || !z.string().uuid().safeParse(evidenceId).success)
        return "no_presence";
      const prepared = await deps.prepare(interaction, evidenceId);
      if (prepared !== "prepared") return "presence_denied";
      return await deps.respond(interaction);
    } catch {
      // Never retry automatically: an exception after intake can mean a
      // persisted received event or an uncertain fake-delivery outcome.
      return "presence_denied";
    }
  };
}
