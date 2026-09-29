import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { capabilityLevel, capabilitySource } from "./enums.js";
import { npcs } from "./npcs.js";

export const npcCapabilities = pgTable(
  "npc_capabilities",
  {
    npcId: uuid("npc_id")
      .notNull()
      .references(() => npcs.entityId, { onDelete: "restrict" }),
    capabilityKey: text("capability_key").notNull(),
    level: capabilityLevel("level").notNull(),
    source: capabilitySource("source").notNull(),
    confidence: real("confidence").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.npcId, table.capabilityKey] }),
    check(
      "npc_capabilities_confidence_range",
      sql`${table.confidence} between 0 and 1`,
    ),
  ],
);
