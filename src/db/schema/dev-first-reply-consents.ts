import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { entities } from "./entities.js";
import { interactions } from "./interactions.js";

// M2.15M: DEV/CI host-only persistence. It is NOT a live-send permit.
// A real operator identity and HTTP action-time fence remain separate gates.
export const devFirstReplyConsents = pgTable(
  "npc_dev_first_reply_consents",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id").notNull(),
    npcId: uuid("npc_id").notNull(),
    contextId: uuid("context_id").notNull(),
    interactionId: uuid("interaction_id").notNull(),
    playerEntityId: uuid("player_entity_id").notNull(),
    // The original Discord event binds the consent irreversibly. It is
    // already received when the operator selects it for one reply.
    sourceMessageId: text("source_message_id").notNull(),
    sourceGuildId: text("source_guild_id").notNull(),
    sourceParentId: text("source_parent_id").notNull(),
    sourceThreadId: text("source_thread_id").notNull(),
    // Attribution only: trusted DB role is the temporary DEV/CI host
    // boundary. This is not an authenticated Discord DM identity.
    operatorEntityId: uuid("operator_entity_id").notNull(),
    issuedBy: text("issued_by")
      .notNull()
      .default(sql`current_user`),
    fixedReply: text("fixed_reply").notNull(),
    status: text("status", {
      enum: ["approved", "claimed", "revoked"],
    })
      .notNull()
      .default("approved"),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attemptId: uuid("attempt_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
  },
  (t) => [
    // Prevent re-issuing consent after *any* terminal outcome or a new
    // consent UUID, including after the attempt is uncertain.
    unique("dev_reply_one_event_per_world").on(
      t.worldId,
      t.sourceMessageId,
    ),
    unique("dev_reply_one_consent_per_interaction").on(
      t.worldId,
      t.interactionId,
    ),
    foreignKey({
      name: "dev_reply_original_interaction_scope_fk",
      columns: [t.worldId, t.npcId, t.contextId, t.interactionId],
      foreignColumns: [
        interactions.worldId,
        interactions.npcId,
        interactions.contextId,
        interactions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "dev_reply_player_world_fk",
      columns: [t.worldId, t.playerEntityId],
      foreignColumns: [entities.worldId, entities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "dev_reply_operator_world_fk",
      columns: [t.worldId, t.operatorEntityId],
      foreignColumns: [entities.worldId, entities.id],
    }).onDelete("restrict"),
    index("dev_reply_world_status_idx").on(t.worldId, t.status),
    check(
      "dev_reply_fixed_text",
      sql`${t.fixedReply} = 'Acknowledged. Standing by.'`,
    ),
    check(
      "dev_reply_snowflakes",
      sql`${t.sourceMessageId} ~ '^[0-9]{17,20}$' and
        ${t.sourceGuildId} ~ '^[0-9]{17,20}$' and
        ${t.sourceParentId} ~ '^[0-9]{17,20}$' and
        ${t.sourceThreadId} ~ '^[0-9]{17,20}$'`,
    ),
    check(
      "dev_reply_time_window",
      sql`${t.expiresAt} > ${t.issuedAt} and
        ${t.expiresAt} <= ${t.issuedAt} + interval '5 minutes'`,
    ),
    check(
      "dev_reply_terminal_shape",
      sql`(
        ${t.status} = 'approved'
        and ${t.attemptId} is null
        and ${t.claimedAt} is null
        and ${t.revokedAt} is null
        and ${t.revokedBy} is null
      ) or (
        ${t.status} = 'claimed'
        and ${t.attemptId} is not null
        and ${t.claimedAt} is not null
        and ${t.revokedAt} is null
        and ${t.revokedBy} is null
      ) or (
        ${t.status} = 'revoked'
        and ${t.attemptId} is null
        and ${t.claimedAt} is null
        and ${t.revokedAt} is not null
        and ${t.revokedBy} is not null
      )`,
    ),
  ],
);
