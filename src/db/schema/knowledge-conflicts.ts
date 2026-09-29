import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { knowledgeConflictStatus } from "./enums.js";
import { npcKnowledge } from "./npc-knowledge.js";
import { npcs } from "./npcs.js";
import { worlds } from "./worlds.js";

export const knowledgeConflicts = pgTable(
  "knowledge_conflicts",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "restrict" }),
    npcId: uuid("npc_id")
      .notNull()
      .references(() => npcs.entityId, { onDelete: "restrict" }),
    claimAId: uuid("claim_a_id")
      .notNull()
      .references(() => npcKnowledge.id, { onDelete: "restrict" }),
    claimBId: uuid("claim_b_id")
      .notNull()
      .references(() => npcKnowledge.id, { onDelete: "restrict" }),
    status: knowledgeConflictStatus("status").notNull().default("unresolved"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
  },
  (table) => [
    check(
      "knowledge_conflicts_distinct_claims",
      sql`${table.claimAId} <> ${table.claimBId}`,
    ),
    check(
      "knowledge_conflicts_canonical_pair",
      sql`${table.claimAId} < ${table.claimBId}`,
    ),
    index("knowledge_conflicts_world_npc_idx").on(table.worldId, table.npcId),
    uniqueIndex("knowledge_conflicts_unique_pair_idx").on(
      table.claimAId,
      table.claimBId,
    ),
  ],
);
