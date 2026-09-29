import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { entities } from "./entities.js";
import {
  knowledgeClassification,
  knowledgeSecrecy,
  knowledgeStatus,
} from "./enums.js";
import { npcs } from "./npcs.js";
import { worlds } from "./worlds.js";

export const npcKnowledge = pgTable(
  "npc_knowledge",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "restrict" }),
    npcId: uuid("npc_id")
      .notNull()
      .references(() => npcs.entityId, { onDelete: "restrict" }),
    subjectEntityId: uuid("subject_entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),
    predicate: text("predicate"),
    objectEntityId: uuid("object_entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),
    objectValue: jsonb("object_value").$type<unknown>(),
    claimText: text("claim_text").notNull(),
    classification: knowledgeClassification("classification").notNull(),
    confidence: real("confidence").notNull(),
    secrecy: knowledgeSecrecy("secrecy").notNull(),
    status: knowledgeStatus("status").notNull().default("current"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "npc_knowledge_confidence_range",
      sql`${table.confidence} between 0 and 1`,
    ),
    index("npc_knowledge_world_npc_idx").on(table.worldId, table.npcId),
    index("npc_knowledge_world_npc_status_idx").on(
      table.worldId,
      table.npcId,
      table.status,
    ),
  ],
);
