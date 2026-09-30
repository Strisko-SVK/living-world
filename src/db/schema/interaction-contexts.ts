import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { entities } from "./entities.js";
import { interactionContextStatus, interactionContextType } from "./enums.js";
import { worlds } from "./worlds.js";

export const interactionContexts = pgTable(
  "interaction_contexts",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "restrict" }),
    contextType: interactionContextType("context_type").notNull(),
    externalProvider: text("external_provider"),
    externalGuildId: text("external_guild_id"),
    externalChannelId: text("external_channel_id"),
    externalThreadId: text("external_thread_id"),
    linkedLocationEntityId: uuid("linked_location_entity_id").references(
      () => entities.id,
      { onDelete: "restrict" },
    ),
    status: interactionContextStatus("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("interaction_contexts_world_id_idx").on(table.worldId),
    index("interaction_contexts_external_ref_idx").on(
      table.worldId,
      table.externalProvider,
      table.externalChannelId,
      table.externalThreadId,
    ),
  ],
);
