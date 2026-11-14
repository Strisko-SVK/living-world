import { z } from "zod";
import {
  assessOfflineSpeechReadiness,
  type OfflineSpeechReadinessRequest,
} from "../communication/scene-speech-readiness.js";

// The first owner-visible pilot is deliberately planned around one harmless,
// predetermined reply. This module only previews OFFLINE eligibility: it has
// no provider, Discord, HTTP, write operation or execution token.
export const firstReplyText = "Acknowledged. Standing by.";

const uuid = z.string().uuid();
const discordId = z.string().regex(/^\d{17,20}$/u);
const scopeSchema = z
  .object({
    worldId: uuid,
    npcId: uuid,
    contextId: uuid,
    interactionId: uuid,
  })
  .strict();
const requestSchema = scopeSchema
  .extend({
    playerEntityId: uuid,
    sourceMessageId: discordId,
    guildId: discordId,
    parentId: discordId,
    threadId: discordId,
  })
  .strict();

const sourceSchema = scopeSchema
  .extend({
    speakerEntityId: uuid,
    sourceProvider: z.literal("discord"),
    sourceMessageId: discordId,
    sourceGuildId: discordId,
    sourceChannelId: discordId,
    sourceThreadId: discordId,
    sourceMappingId: uuid,
    status: z.literal("received"),
    communicationMode: z.literal("unknown"),
    localPresenceId: z.null(),
    responseText: z.null(),
    responseClaimId: z.null(),
  })
  .strict();

export type FirstReplyScope = z.infer<typeof scopeSchema>;
export type FirstReplyRequest = z.infer<typeof requestSchema>;
export type FirstReplySource = z.infer<typeof sourceSchema>;
export type FirstReplyFacts = {
  // This must originate from readVerifiedOfflineSpeechPhaseSnapshot at
  // phase "received", not a player or caller-supplied assertion.
  speech: OfflineSpeechReadinessRequest;
  source: FirstReplySource;
  deliveryCount: number;
};
export type FirstReplyPreviewReason =
  | "offline_only"
  | "invalid_request"
  | "unverified"
  | "source_mismatch"
  | "delivery_exists"
  | "host_policy_denied"
  | "fake_only_eligible";

export type FirstReplyPreview = {
  event: "npc_first_reply_preflight";
  status: "blocked" | "fake_only_candidate";
  reason: FirstReplyPreviewReason;
  readOnly: true;
  wouldSend: false;
  canGenerate: false;
  canSend: false;
  canRehearseFake: boolean;
  fixedReply?: typeof firstReplyText;
};

function output(
  reason: FirstReplyPreviewReason,
  eligible = false,
): FirstReplyPreview {
  return {
    event: "npc_first_reply_preflight",
    status: eligible ? "fake_only_candidate" : "blocked",
    reason,
    readOnly: true,
    wouldSend: false,
    canGenerate: false,
    canSend: false,
    canRehearseFake: eligible,
    ...(eligible ? { fixedReply: firstReplyText } : {}),
  };
}

function offlineCiOnly() {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.DISCORD_ENABLED === "false" &&
    process.env.DISCORD_OUTBOUND_ENABLED === "false" &&
    process.env.LLM_PROVIDER === "disabled"
  );
}

// Advisory preflight only. Even a positive result is NOT an operator identity,
// owner consent, durable one-shot latch or permission to execute a real send.
// Future live execution must independently re-read authoritative DB facts at
// the action boundary and obtain a separately approved owner opt-in.
export function createOfflineFirstReplyPreflight(
  readTrusted: (scope: FirstReplyScope) => Promise<FirstReplyFacts | null>,
) {
  return async (raw: unknown): Promise<FirstReplyPreview> => {
    if (!offlineCiOnly()) return output("offline_only");
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return output("invalid_request");

    const request = parsed.data;
    const scope: FirstReplyScope = {
      worldId: request.worldId,
      npcId: request.npcId,
      contextId: request.contextId,
      interactionId: request.interactionId,
    };
    try {
      const facts = await readTrusted(scope);
      if (!facts) return output("unverified");
      const source = sourceSchema.safeParse(facts.source);
      if (!source.success) return output("unverified");
      const s = source.data;
      if (
        s.worldId !== request.worldId ||
        s.npcId !== request.npcId ||
        s.contextId !== request.contextId ||
        s.interactionId !== request.interactionId ||
        s.speakerEntityId !== request.playerEntityId ||
        s.sourceMessageId !== request.sourceMessageId ||
        s.sourceGuildId !== request.guildId ||
        s.sourceChannelId !== request.parentId ||
        s.sourceThreadId !== request.threadId ||
        facts.speech.worldId !== request.worldId ||
        facts.speech.npcId !== request.npcId ||
        facts.speech.contextId !== request.contextId ||
        facts.speech.interactionId !== request.interactionId ||
        facts.speech.sourceMessageId !== request.sourceMessageId
      )
        return output("source_mismatch");
      if (facts.deliveryCount !== 0) return output("delivery_exists");
      if (
        facts.speech.approval?.issuedByRole !== "host_operator" ||
        !assessOfflineSpeechReadiness(facts.speech).canRehearseFake
      )
        return output("host_policy_denied");
      return output("fake_only_eligible", true);
    } catch {
      // Never expose Discord identities, source content, SQL or secret data.
      return output("unverified");
    }
  };
}
