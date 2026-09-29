import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { locationCertainty } from "./enums.js";
import { npcs } from "./npcs.js";

export const npcState = pgTable(
  "npc_state",
  {
    npcId: uuid("npc_id")
      .primaryKey()
      .references(() => npcs.entityId, { onDelete: "restrict" }),
    currentLocationId: uuid("current_location_id"),
    locationCertainty: locationCertainty("location_certainty").notNull(),
    physicalState: jsonb("physical_state")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    emotionalState: jsonb("emotional_state")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    materialState: jsonb("material_state")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    availabilityState: jsonb("availability_state")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("npc_state_version_positive", sql`${table.version} > 0`)],
);
