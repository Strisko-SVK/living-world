import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { worldStatus } from "./enums.js";

export const worlds = pgTable(
  "worlds",
  {
    id: uuid("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    systemType: text("system_type").notNull(),
    status: worldStatus("status").notNull(),
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("worlds_key_unique").on(table.key)],
);
