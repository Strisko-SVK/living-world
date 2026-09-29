import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { entities } from "./entities.js";

export const entityAliases = pgTable(
  "entity_aliases",
  {
    id: uuid("id").primaryKey(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "restrict" }),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
  },
  (table) => [
    uniqueIndex("entity_aliases_entity_id_normalized_alias_unique").on(
      table.entityId,
      table.normalizedAlias,
    ),
    index("entity_aliases_normalized_alias_idx").on(table.normalizedAlias),
    index("entity_aliases_entity_id_idx").on(table.entityId),
  ],
);
