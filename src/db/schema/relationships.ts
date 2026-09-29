import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { entities } from "./entities.js";
import { relationshipIntent } from "./enums.js";
import { worlds } from "./worlds.js";

export const relationships = pgTable(
  "relationships",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "restrict" }),
    sourceEntityId: uuid("source_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "restrict" }),
    targetEntityId: uuid("target_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "restrict" }),
    familiarity: integer("familiarity").notNull().default(0),
    trust: integer("trust").notNull().default(50),
    respect: integer("respect").notNull().default(50),
    affection: integer("affection").notNull().default(0),
    fear: integer("fear").notNull().default(0),
    resentment: integer("resentment").notNull().default(0),
    dependence: integer("dependence").notNull().default(0),
    obligation: integer("obligation").notNull().default(0),
    intent: relationshipIntent("intent"),
    utility: jsonb("utility").$type<unknown>(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "relationships_distinct_entities",
      sql`${table.sourceEntityId} <> ${table.targetEntityId}`,
    ),
    check(
      "relationships_familiarity_range",
      sql`${table.familiarity} between 0 and 100`,
    ),
    check("relationships_trust_range", sql`${table.trust} between 0 and 100`),
    check(
      "relationships_respect_range",
      sql`${table.respect} between 0 and 100`,
    ),
    check(
      "relationships_affection_range",
      sql`${table.affection} between 0 and 100`,
    ),
    check("relationships_fear_range", sql`${table.fear} between 0 and 100`),
    check(
      "relationships_resentment_range",
      sql`${table.resentment} between 0 and 100`,
    ),
    check(
      "relationships_dependence_range",
      sql`${table.dependence} between 0 and 100`,
    ),
    check(
      "relationships_obligation_range",
      sql`${table.obligation} between 0 and 100`,
    ),
    check("relationships_version_positive", sql`${table.version} > 0`),
    uniqueIndex("relationships_world_source_target_idx").on(
      table.worldId,
      table.sourceEntityId,
      table.targetEntityId,
    ),
  ],
);
