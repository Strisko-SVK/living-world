import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import { devFirstReplyConsents } from "../db/schema/dev-first-reply-consents.js";
import { interactions } from "../db/schema/interactions.js";
import { worlds } from "../db/schema/worlds.js";
import { entities } from "../db/schema/entities.js";
import { sceneSpeechPolicies } from "../db/schema/scene-speech-policies.js";
import { discordMessageCreatedAt } from "../intake/discord-snowflake.js";
import { firstReplyText } from "../offline/npc-first-reply-preflight.js";
import { inspectDevFirstReplyFacts } from "./npc-dev-first-reply-preview.js";

// Only internal, trusted host/CI code may call these functions. No CLI,
// Discord listener, HTTP endpoint, live provider or transport imports.
// The persistent claim itself is NOT permission to send.
type Database = Omit<DatabaseClient["db"], "$client">;
const uuid = z.string().uuid();
const snowflake = z.string().regex(/^[0-9]{17,20}$/u);
const target = z
  .object({
    worldKey: z.string().min(1).max(80),
    worldId: uuid,
    npcId: uuid,
    contextId: uuid,
    interactionId: uuid,
    playerEntityId: uuid,
    playerDiscordId: snowflake,
    sourceMessageId: snowflake,
    guildId: snowflake,
    parentId: snowflake,
    threadId: snowflake,
    operatorEntityId: uuid,
  })
  .strict();
const issueRequest = target.extend({
  // A small TTL, and event freshness remains limited to two minutes.
  ttlSeconds: z.number().int().min(1).max(120),
});
const existingRequest = target.extend({ consentId: uuid });
type Target = z.infer<typeof target>;
export type DevOneShotIssueRequest = z.infer<typeof issueRequest>;
export type DevOneShotClaimRequest = z.infer<typeof existingRequest>;

type Status =
  | "invalid_request"
  | "operator_only"
  | "blocked"
  | "already_reserved"
  | "issued"
  | "claimed"
  | "revoked";
export type DevConsentOutcome = {
  event: "npc_dev_one_shot_consent";
  status: Status;
  readOnly: false;
  canGenerate: false;
  canSend: false;
  wouldSend: false;
  consentId?: string;
  attemptId?: string;
};
const output = (
  status: Status,
  consentId?: string,
  attemptId?: string,
): DevConsentOutcome => ({
  event: "npc_dev_one_shot_consent",
  status,
  readOnly: false,
  canGenerate: false,
  canSend: false,
  wouldSend: false,
  ...(consentId ? { consentId } : {}),
  ...(attemptId ? { attemptId } : {}),
});

function safeRuntime(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.DISCORD_ENABLED === "false" &&
    process.env.DISCORD_OUTBOUND_ENABLED === "false" &&
    process.env.LLM_PROVIDER === "disabled"
  );
}

async function trustedHost(tx: Database): Promise<boolean> {
  const r = await tx.execute(
    sql`select current_database() as database, current_user as db_role`,
  );
  const v = r.rows[0];
  return (
    (v?.database === "living_world_ci" &&
      v.db_role === "living_world_ci" &&
      process.env.NODE_ENV === "test") ||
    (v?.database === "living_world_gateway_dev" &&
      v.db_role === "lw_gateway_dev")
  );
}

function matching(row: typeof devFirstReplyConsents.$inferSelect, t: Target) {
  return (
    row.worldId === t.worldId &&
    row.npcId === t.npcId &&
    row.contextId === t.contextId &&
    row.interactionId === t.interactionId &&
    row.playerEntityId === t.playerEntityId &&
    row.sourceMessageId === t.sourceMessageId &&
    row.sourceGuildId === t.guildId &&
    row.sourceParentId === t.parentId &&
    row.sourceThreadId === t.threadId &&
    row.operatorEntityId === t.operatorEntityId &&
    row.fixedReply === firstReplyText &&
    row.issuedBy !== ""
  );
}

async function validatedOriginal(tx: Database, t: Target): Promise<boolean> {
  const [world] = await tx
    .select({ key: worlds.key })
    .from(worlds)
    .where(eq(worlds.id, t.worldId))
    .limit(1);
  if (world?.key !== t.worldKey) return false;

  const [source] = await tx
    .select()
    .from(interactions)
    .where(
      and(
        eq(interactions.worldId, t.worldId),
        eq(interactions.npcId, t.npcId),
        eq(interactions.contextId, t.contextId),
        eq(interactions.id, t.interactionId),
      ),
    )
    .for("update");
  if (
    !source ||
    source.sourceMessageId !== t.sourceMessageId ||
    source.speakerEntityId !== t.playerEntityId ||
    source.sourceGuildId !== t.guildId ||
    source.sourceChannelId !== t.parentId ||
    source.sourceThreadId !== t.threadId
  )
    return false;
  const eventMs = discordMessageCreatedAt(t.sourceMessageId);
  if (eventMs === null) return false;

  // The host speech policy predates inbound. By contrast, this consent
  // is deliberately issued AFTER a real event can be bound exactly.
  const preview = await inspectDevFirstReplyFacts(tx, {
    worldKey: t.worldKey,
    guildId: t.guildId,
    channelId: t.parentId,
    threadId: t.threadId,
    playerId: t.playerDiscordId,
  });
  if (
    preview.status !== "fake_only_candidate" ||
    preview.reason !== "validated_fake_only" ||
    preview.canSend !== false
  )
    {
      if (process.env.NODE_ENV === "test") {
        console.info(JSON.stringify({event:"npc_first_reply_ci_issue_diagnostic",reason:preview.reason}));
      }
      return false;
    }

  const [operator] = await tx
    .select({ id: entities.id, status: entities.status })
    .from(entities)
    .where(
      and(eq(entities.worldId, t.worldId), eq(entities.id, t.operatorEntityId)),
    )
    .limit(1);
  if (operator?.status !== "active") return false;

  const policies = await tx
    .select({ operatorId: sceneSpeechPolicies.issuerEntityId })
    .from(sceneSpeechPolicies)
    .where(
      and(
        eq(sceneSpeechPolicies.worldId, t.worldId),
        eq(sceneSpeechPolicies.npcId, t.npcId),
        eq(sceneSpeechPolicies.contextId, t.contextId),
        isNull(sceneSpeechPolicies.revokedAt),
        sql`${sceneSpeechPolicies.expiresAt} > clock_timestamp()`,
      ),
    )
    .limit(2);
  return (
    policies.length === 1 && policies[0]!.operatorId === t.operatorEntityId
  );
}

// Persist an event-bound host consent only after fresh authenticated intake
// has been stored. SQL uniqueness permanently prevents any new approval for
// the same original Discord event, even after revocation or uncertainty.
export async function issueDevOneShotConsent(
  db: Database,
  raw: unknown,
): Promise<DevConsentOutcome> {
  const parsed = issueRequest.safeParse(raw);
  if (!parsed.success) return output("invalid_request");
  if (!safeRuntime()) return output("operator_only");
  const input = parsed.data;
  try {
    return await db.transaction(async (tx) => {
      if (!(await trustedHost(tx))) return output("operator_only");
      if (!(await validatedOriginal(tx, input))) return output("blocked");
      const [row] = await tx
        .insert(devFirstReplyConsents)
        .values({
          id: randomUUID(),
          worldId: input.worldId,
          npcId: input.npcId,
          contextId: input.contextId,
          interactionId: input.interactionId,
          playerEntityId: input.playerEntityId,
          sourceMessageId: input.sourceMessageId,
          sourceGuildId: input.guildId,
          sourceParentId: input.parentId,
          sourceThreadId: input.threadId,
          operatorEntityId: input.operatorEntityId,
          fixedReply: firstReplyText,
          expiresAt: sql`clock_timestamp() + ${input.ttlSeconds}::integer * interval '1 second'`,
        })
        .onConflictDoNothing()
        .returning({ id: devFirstReplyConsents.id });
      return row ? output("issued", row.id) : output("already_reserved");
    });
  } catch {
    if (process.env.NODE_ENV === "test") {
      console.info(JSON.stringify({event:"npc_first_reply_ci_issue_diagnostic",reason:"database_exception"}));
    }
    // A DB failure cannot become authority to send or leak stored content.
    return output("blocked");
  }
}

// Reserve exactly ONE attempt, durably, BEFORE a future network boundary.
// A claimed record is terminal and cannot be rearmed/reused; this method
// itself NEVER initiates, enables or authorizes any HTTP or Discord request.
export async function claimDevOneShotConsent(
  db: Database,
  raw: unknown,
): Promise<DevConsentOutcome> {
  const parsed = existingRequest.safeParse(raw);
  if (!parsed.success) return output("invalid_request");
  if (!safeRuntime()) return output("operator_only");
  const input = parsed.data;
  try {
    return await db.transaction(async (tx) => {
      if (!(await trustedHost(tx))) return output("operator_only");
      // Same lock order as issuance: original interaction first, then
      // consent row. Prevent competing issue/claim transactions inverting
      // their lock ordering while preserving one-event uniqueness.
      if (!(await validatedOriginal(tx, input))) return output("blocked");
      const [row] = await tx
        .select()
        .from(devFirstReplyConsents)
        .where(eq(devFirstReplyConsents.id, input.consentId))
        .for("update");
      if (!row || !matching(row, input) || row.status !== "approved")
        return output("blocked");
      const attemptId = randomUUID();
      const [claimed] = await tx
        .update(devFirstReplyConsents)
        .set({
          status: "claimed",
          attemptId,
          claimedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(devFirstReplyConsents.id, input.consentId),
            eq(devFirstReplyConsents.status, "approved"),
            sql`${devFirstReplyConsents.expiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ id: devFirstReplyConsents.id });
      return claimed
        ? output("claimed", claimed.id, attemptId)
        : output("blocked");
    });
  } catch {
    return output("blocked");
  }
}

// Cancellation only before the first claim; never deletes/refunds the event.
export async function revokeDevOneShotConsent(
  db: Database,
  raw: unknown,
): Promise<DevConsentOutcome> {
  const parsed = existingRequest.safeParse(raw);
  if (!parsed.success) return output("invalid_request");
  if (!safeRuntime()) return output("operator_only");
  const input = parsed.data;
  try {
    return await db.transaction(async (tx) => {
      if (!(await trustedHost(tx))) return output("operator_only");
      const [row] = await tx
        .select()
        .from(devFirstReplyConsents)
        .where(eq(devFirstReplyConsents.id, input.consentId))
        .for("update");
      if (!row || !matching(row, input) || row.status !== "approved")
        return output("blocked");
      const [updated] = await tx
        .update(devFirstReplyConsents)
        .set({
          status: "revoked",
          revokedAt: sql`clock_timestamp()`,
          revokedBy: sql`current_user`,
        })
        .where(
          and(
            eq(devFirstReplyConsents.id, input.consentId),
            eq(devFirstReplyConsents.status, "approved"),
            sql`${devFirstReplyConsents.expiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ id: devFirstReplyConsents.id });
      return updated ? output("revoked", updated.id) : output("blocked");
    });
  } catch {
    return output("blocked");
  }
}
