import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { entities } from "./entities.js";
import { npcLifecycleState } from "./enums.js";

export const npcs = pgTable(
  "npcs",
  {
    entityId: uuid("entity_id")
      .primaryKey()
      .references(() => entities.id, { onDelete: "restrict" }),
    simulationDepth: integer("simulation_depth").notNull(),
    narrativeWeight: integer("narrative_weight").notNull(),
    lifecycleState: npcLifecycleState("lifecycle_state").notNull(),
    canonProtected: boolean("canon_protected").notNull().default(false),
    templateVersion: integer("template_version").notNull(),
    profileVersion: integer("profile_version").notNull(),
    baselineProfile: jsonb("baseline_profile")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "npcs_simulation_depth_range",
      sql`${table.simulationDepth} between 0 and 3`,
    ),
    check(
      "npcs_narrative_weight_range",
      sql`${table.narrativeWeight} between 0 and 100`,
    ),
    check("npcs_template_version_positive", sql`${table.templateVersion} > 0`),
    check("npcs_profile_version_positive", sql`${table.profileVersion} > 0`),
  ],
);
