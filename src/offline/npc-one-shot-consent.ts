import { z } from "zod";
import { discordMessageCreatedAt } from "../intake/discord-snowflake.js";
import {
  firstReplyText,
  type FirstReplyPreview,
  type FirstReplyRequest,
} from "./npc-first-reply-preflight.js";

// M2.15K models one strictly bounded, single-use pilot in disposable tests.
// This is NOT a production operator identity, DB-backed authorization or a
// real send boundary. There are no Discord, LLM, HTTP or database imports.
const uuid = z.string().uuid();
const snowflake = z.string().regex(/^\d{17,20}$/u);
const targetSchema = z
  .object({
    worldId: uuid,
    npcId: uuid,
    contextId: uuid,
    interactionId: uuid,
    playerEntityId: uuid,
    sourceMessageId: snowflake,
    guildId: snowflake,
    parentId: snowflake,
    threadId: snowflake,
  })
  .strict();

const consentSchema = z
  .object({
    id: uuid,
    issuedByOperatorId: uuid,
    issuerRole: z.literal("host_operator"),
    target: targetSchema,
    fixedReply: z.literal(firstReplyText),
    issuedAt: z.date(),
    expiresAt: z.date(),
    revokedAt: z.date().nullable(),
  })
  .strict();

export type OfflinePilotConsent = z.infer<typeof consentSchema>;
export type OfflinePilotTarget = z.infer<typeof targetSchema>;
type FakeOutcome = "ack" | "not_sent" | "uncertain";

export interface OfflinePilotDependencies {
  // Both reads must come from authoritative, independently authenticated
  // storage in a future implementation, never user/Discord message content.
  preflight(target: FirstReplyRequest): Promise<FirstReplyPreview>;
  readTrustedConsent(target: FirstReplyRequest): Promise<unknown>;
  // Test double MUST atomically consume the first attempt before fakeSend.
  // An uncertain claim is never retried automatically.
  claimOnce(consentId: string, target: FirstReplyRequest): Promise<boolean>;
  fakeSend(input: {
    target: FirstReplyRequest;
    text: typeof firstReplyText;
  }): Promise<FakeOutcome>;
  clock?: () => Date;
}

export type OfflinePilotOutcome =
  | "offline_only"
  | "invalid_request"
  | "preflight_denied"
  | "consent_denied"
  | "already_consumed"
  | "claim_uncertain"
  | "revoked_after_claim"
  | "fake_ack"
  | "fake_not_sent"
  | "fake_uncertain";

export type OfflinePilotResult = {
  event: "npc_offline_one_shot_pilot";
  outcome: OfflinePilotOutcome;
  readOnly: true;
  canGenerate: false;
  canSend: false;
  wouldSend: false;
};

const result = (outcome: OfflinePilotOutcome): OfflinePilotResult => ({
  event: "npc_offline_one_shot_pilot",
  outcome,
  readOnly: true,
  canGenerate: false,
  canSend: false,
  wouldSend: false,
});

function testOnly(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.DISCORD_ENABLED === "false" &&
    process.env.DISCORD_OUTBOUND_ENABLED === "false" &&
    process.env.LLM_PROVIDER === "disabled"
  );
}

const fields = [
  "worldId",
  "npcId",
  "contextId",
  "interactionId",
  "playerEntityId",
  "sourceMessageId",
  "guildId",
  "parentId",
  "threadId",
] as const;

function eligiblePreview(preview: FirstReplyPreview): boolean {
  return (
    preview.status === "fake_only_candidate" &&
    preview.reason === "fake_only_eligible" &&
    preview.readOnly === true &&
    preview.canRehearseFake === true &&
    preview.canGenerate === false &&
    preview.canSend === false &&
    preview.wouldSend === false &&
    preview.fixedReply === firstReplyText
  );
}

function validConsent(
  input: unknown,
  target: OfflinePilotTarget,
  now: Date,
): OfflinePilotConsent | null {
  const parsed = consentSchema.safeParse(input);
  if (!parsed.success) return null;
  const consent = parsed.data;
  const eventMs = discordMessageCreatedAt(target.sourceMessageId);
  const issued = consent.issuedAt.getTime();
  const expires = consent.expiresAt.getTime();
  const nowMs = now.getTime();

  if (
    consent.revokedAt !== null ||
    !fields.every((field) => consent.target[field] === target[field]) ||
    eventMs === null ||
    !Number.isFinite(nowMs) ||
    expires <= nowMs ||
    issued > nowMs ||
    issued > eventMs ||
    expires <= issued ||
    expires - issued > 300_000 ||
    eventMs > nowMs ||
    nowMs - eventMs > 120_000
  )
    return null;
  return consent;
}

// No legitimate caller can convert this result to live permission. Even an
// acknowledged fake attempt reports canSend=false. Claim is consumed before
// the fake boundary; retries after any ambiguity are forbidden.
export function createOfflineOneShotPilot(deps: OfflinePilotDependencies) {
  const clock = deps.clock ?? (() => new Date());
  return async (raw: unknown): Promise<OfflinePilotResult> => {
    if (!testOnly()) return result("offline_only");
    const parsed = targetSchema.safeParse(raw);
    if (!parsed.success) return result("invalid_request");

    const target = parsed.data;
    let consent: OfflinePilotConsent;
    try {
      if (!eligiblePreview(await deps.preflight(target)))
        return result("preflight_denied");
      const candidate = validConsent(
        await deps.readTrustedConsent(target),
        target,
        clock(),
      );
      if (!candidate) return result("consent_denied");
      consent = candidate;
    } catch {
      return result("consent_denied");
    }

    try {
      if (!(await deps.claimOnce(consent.id, target)))
        return result("already_consumed");
    } catch {
      return result("claim_uncertain");
    }

    // Once claimed, every negative result consumes this one-shot attempt.
    // This second read closes common preflight-to-send races only in the
    // fake model; production requires a DB transaction-bound real send fence.
    try {
      const preview = await deps.preflight(target);
      const current = validConsent(
        await deps.readTrustedConsent(target),
        target,
        clock(),
      );
      if (
        !eligiblePreview(preview) ||
        !current ||
        current.id !== consent.id ||
        current.issuedAt.getTime() !== consent.issuedAt.getTime() ||
        current.expiresAt.getTime() !== consent.expiresAt.getTime()
      )
        return result("revoked_after_claim");
    } catch {
      return result("revoked_after_claim");
    }

    try {
      const sent = await deps.fakeSend({ target, text: firstReplyText });
      switch (sent) {
        case "ack":
          return result("fake_ack");
        case "not_sent":
          return result("fake_not_sent");
        default:
          return result("fake_uncertain");
      }
    } catch {
      return result("fake_uncertain");
    }
  };
}
