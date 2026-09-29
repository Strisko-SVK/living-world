import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import {
  memoryDetailLevel,
  memoryRetentionClass,
  memoryStatus,
  memoryType,
} from "./enums.js";
import { npcs } from "./npcs.js";
import { worlds } from "./worlds.js";

export const npcMemories = pgTable(
  "npc_memories",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "restrict" }),
    npcId: uuid("npc_id")
      .notNull()
      .references(() => npcs.entityId, { onDelete: "restrict" }),
    memoryType: memoryType("memory_type").notNull(),
    summary: text("summary").notNull(),
    importance: integer("importance").notNull(),
    detailLevel: memoryDetailLevel("detail_level").notNull(),
    retentionClass: memoryRetentionClass("retention_class").notNull(),
    status: memoryStatus("status").notNull().default("active"),
    emotionalTags: text("emotional_tags").array().notNull().default([]),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "npc_memories_importance_range",
      sql`${table.importance} between 0 and 100`,
    ),
    index("npc_memories_world_npc_idx").on(table.worldId, table.npcId),
    index("npc_memories_world_npc_status_idx").on(
      table.worldId,
      table.npcId,
      table.status,
    ),
  ],
);
