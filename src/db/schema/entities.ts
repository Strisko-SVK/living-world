import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { entityStatus, entityType } from "./enums.js";
import { worlds } from "./worlds.js";

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "restrict" }),
    entityType: entityType("entity_type").notNull(),
    canonicalName: text("canonical_name").notNull(),
    status: entityStatus("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("entities_world_id_unique").on(table.worldId, table.id),
    index("entities_world_id_idx").on(table.worldId),
    index("entities_world_id_canonical_name_idx").on(
      table.worldId,
      table.canonicalName,
    ),
  ],
);
