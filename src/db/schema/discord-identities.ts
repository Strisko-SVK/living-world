import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { entities } from "./entities.js";
import { discordIdentityMappingType, discordIdentityStatus } from "./enums.js";
import { worlds } from "./worlds.js";

export const discordIdentities = pgTable(
  "discord_identities",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "restrict" }),
    discordUserId: text("discord_user_id").notNull(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "restrict" }),
    mappingType: discordIdentityMappingType("mapping_type").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    status: discordIdentityStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("discord_identities_world_user_idx").on(
      table.worldId,
      table.discordUserId,
    ),
    index("discord_identities_world_user_primary_idx").on(
      table.worldId,
      table.discordUserId,
      table.isPrimary,
    ),
    uniqueIndex("discord_identities_duplicate_mapping_idx").on(
      table.worldId,
      table.discordUserId,
      table.entityId,
      table.mappingType,
    ),
  ],
);
