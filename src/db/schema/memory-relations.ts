import {
  check,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { memoryRelationType } from "./enums.js";
import { npcMemories } from "./npc-memories.js";

export const memoryRelations = pgTable(
  "memory_relations",
  {
    parentMemoryId: uuid("parent_memory_id")
      .notNull()
      .references(() => npcMemories.id, { onDelete: "restrict" }),
    childMemoryId: uuid("child_memory_id")
      .notNull()
      .references(() => npcMemories.id, { onDelete: "restrict" }),
    relationType: memoryRelationType("relation_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.parentMemoryId, table.childMemoryId, table.relationType],
    }),
    check(
      "memory_relations_no_self_relation",
      sql`${table.parentMemoryId} <> ${table.childMemoryId}`,
    ),
  ],
);
