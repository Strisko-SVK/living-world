import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { npcs } from "./npcs.js";

export const npcGameProfiles = pgTable(
  "npc_game_profiles",
  {
    npcId: uuid("npc_id")
      .primaryKey()
      .references(() => npcs.entityId, { onDelete: "restrict" }),
    gameSystem: text("game_system").notNull(),
    statDepth: integer("stat_depth").notNull(),
    characteristics: jsonb("characteristics")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    skills: jsonb("skills")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    talents: jsonb("talents")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    combat: jsonb("combat")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    gear: jsonb("gear").$type<Record<string, unknown>>().notNull().default({}),
    derivedValues: jsonb("derived_values")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    sourceNotes: jsonb("source_notes")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "npc_game_profiles_stat_depth_range",
      sql`${table.statDepth} between 0 and 3`,
    ),
    check("npc_game_profiles_version_positive", sql`${table.version} > 0`),
  ],
);
