import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { entities } from "./entities.js";
import { memorySourceType } from "./enums.js";
import { npcMemories } from "./npc-memories.js";

export const memorySources = pgTable(
  "memory_sources",
  {
    id: uuid("id").primaryKey(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => npcMemories.id, { onDelete: "restrict" }),
    sourceType: memorySourceType("source_type").notNull(),
    sourceId: text("source_id"),
    sourceEntityId: uuid("source_entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),
    sourceInteractionId: uuid("source_interaction_id"),
    provenanceNote: text("provenance_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("memory_sources_memory_id_idx").on(table.memoryId)],
);
