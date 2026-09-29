import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { relationshipEventType } from "./enums.js";
import { npcKnowledge } from "./npc-knowledge.js";
import { npcMemories } from "./npc-memories.js";
import { relationships } from "./relationships.js";

export const relationshipEvents = pgTable(
  "relationship_events",
  {
    id: uuid("id").primaryKey(),
    relationshipId: uuid("relationship_id")
      .notNull()
      .references(() => relationships.id, { onDelete: "restrict" }),
    eventType: relationshipEventType("event_type").notNull(),
    delta: jsonb("delta").$type<Record<string, number>>().notNull(),
    reasonSummary: text("reason_summary").notNull(),
    sourceInteractionId: uuid("source_interaction_id"),
    sourceMemoryId: uuid("source_memory_id").references(() => npcMemories.id, {
      onDelete: "restrict",
    }),
    sourceKnowledgeId: uuid("source_knowledge_id").references(
      () => npcKnowledge.id,
      { onDelete: "restrict" },
    ),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("relationship_events_relationship_id_idx").on(table.relationshipId),
  ],
);
