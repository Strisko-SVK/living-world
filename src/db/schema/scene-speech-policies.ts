import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { entities } from "./entities.js";
import { localPresence } from "./local-presence.js";

// Only the trusted, local database operator can create or revoke these
// records. This is NOT a Discord DM role or automatic speech permission.
export const sceneSpeechPolicies = pgTable(
  "npc_scene_speech_policies",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id").notNull(),
    npcId: uuid("npc_id").notNull(),
    contextId: uuid("context_id").notNull(),
    presenceId: uuid("presence_id").notNull(),
    npcStateVersion: integer("npc_state_version").notNull(),
    // Attribution only; auth is the verified local database role, not a
    // caller-supplied entity ID or Discord display name.
    issuerEntityId: uuid("issuer_entity_id").notNull(),
    issuerRole: text("issuer_role").notNull(),
    issuedBy: text("issued_by")
      .notNull()
      .default(sql`current_user`),
    decision: text("decision").notNull(),
    activity: text("activity").notNull(),
    perception: text("perception").notNull(),
    otherScene: text("other_scene").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
  },
  (t) => [
    foreignKey({
      name: "scene_speech_presence_scope_fk",
      columns: [t.worldId, t.npcId, t.contextId, t.presenceId],
      foreignColumns: [
        localPresence.worldId,
        localPresence.npcId,
        localPresence.contextId,
        localPresence.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "scene_speech_issuer_world_fk",
      columns: [t.worldId, t.issuerEntityId],
      foreignColumns: [entities.worldId, entities.id],
    }).onDelete("restrict"),
    uniqueIndex("scene_speech_one_open_policy")
      .on(t.worldId, t.npcId, t.contextId)
      .where(sql`${t.revokedAt} is null`),
    index("scene_speech_world_presence_idx").on(
      t.worldId,
      t.npcId,
      t.contextId,
      t.presenceId,
    ),
    check(
      "scene_speech_role_host_only",
      sql`${t.issuerRole} = 'host_operator'`,
    ),
    check(
      "scene_speech_decision_values",
      sql`${t.decision} in ('allow_direct_speech','hold','deny')`,
    ),
    check(
      "scene_speech_activity_values",
      sql`${t.activity} in ('free','busy','unavailable')`,
    ),
    check(
      "scene_speech_perception_values",
      sql`${t.perception} in ('aware','unaware')`,
    ),
    check(
      "scene_speech_occupancy_values",
      sql`${t.otherScene} in ('none','active')`,
    ),
    check("scene_speech_positive_revision", sql`${t.npcStateVersion} > 0`),
    check(
      "scene_speech_bounded_window",
      sql`${t.expiresAt} > ${t.issuedAt} and ${t.expiresAt} <= ${t.issuedAt} + interval '30 minutes'`,
    ),
    check(
      "scene_speech_revocation_shape",
      sql`(${t.revokedAt} is null) = (${t.revokedBy} is null)`,
    ),
  ],
);
