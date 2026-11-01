import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { entities } from "./entities.js";
import { npcs } from "./npcs.js";
import { interactionContexts } from "./interaction-contexts.js";

export const localPresence = pgTable(
  "local_presence",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id").notNull(),
    npcId: uuid("npc_id")
      .notNull()
      .references(() => npcs.entityId, { onDelete: "restrict" }),
    contextId: uuid("context_id").notNull(),
    locationId: uuid("location_id").notNull(),
    stateVersion: integer("state_version").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    issuedBy: text("issued_by")
      .notNull()
      .default(sql`current_user`),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
  },
  (t) => [
    unique("local_presence_binding_unique").on(
      t.worldId,
      t.npcId,
      t.contextId,
      t.id,
    ),
    uniqueIndex("local_presence_active_unique")
      .on(t.worldId, t.npcId, t.contextId)
      .where(sql`${t.revokedAt} is null`),
    foreignKey({
      name: "local_presence_npc_world_fk",
      columns: [t.worldId, t.npcId],
      foreignColumns: [entities.worldId, entities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "local_presence_context_world_fk",
      columns: [t.worldId, t.contextId],
      foreignColumns: [interactionContexts.worldId, interactionContexts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "local_presence_location_world_fk",
      columns: [t.worldId, t.locationId],
      foreignColumns: [entities.worldId, entities.id],
    }).onDelete("restrict"),
    check(
      "local_presence_revocation_shape",
      sql`(${t.revokedAt} is null) = (${t.revokedBy} is null)`,
    ),
    check("local_presence_state_version", sql`${t.stateVersion} > 0`),
  ],
);
