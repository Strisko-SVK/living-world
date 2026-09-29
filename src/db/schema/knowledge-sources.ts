import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { entities } from "./entities.js";
import { knowledgeSourceType } from "./enums.js";
import { npcKnowledge } from "./npc-knowledge.js";
import { npcMemories } from "./npc-memories.js";

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").primaryKey(),
    knowledgeId: uuid("knowledge_id")
      .notNull()
      .references(() => npcKnowledge.id, { onDelete: "restrict" }),
    sourceType: knowledgeSourceType("source_type").notNull(),
    sourceEntityId: uuid("source_entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),
    sourceKnowledgeId: uuid("source_knowledge_id").references(
      () => npcKnowledge.id,
      { onDelete: "restrict" },
    ),
    sourceMemoryId: uuid("source_memory_id").references(() => npcMemories.id, {
      onDelete: "restrict",
    }),
    externalRef: text("external_ref"),
    chainDepth: integer("chain_depth"),
    provenanceNote: text("provenance_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "knowledge_sources_chain_depth_nonnegative",
      sql`${table.chainDepth} >= 0`,
    ),
    index("knowledge_sources_knowledge_id_idx").on(table.knowledgeId),
  ],
);
