import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { interactionContexts } from "./interaction-contexts.js";
import { npcs } from "./npcs.js";
import {
  discordContextMappingStatus,
  discordContextMappingType,
} from "./enums.js";
import { worlds } from "./worlds.js";
import { entities } from "./entities.js";

export const discordContextMappings = pgTable(
  "discord_context_mappings",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "restrict" }),
    contextId: uuid("context_id")
      .notNull()
      .references(() => interactionContexts.id, { onDelete: "restrict" }),
    // This is populated only for npc_primary mappings; it adds no location data.
    npcId: uuid("npc_id").references(() => npcs.entityId, {
      onDelete: "restrict",
    }),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id"),
    mappingType: discordContextMappingType("mapping_type").notNull(),
    status: discordContextMappingStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("discord_context_mappings_location_unique")
      .on(table.worldId, table.guildId, table.channelId, table.threadId)
      .nullsNotDistinct(),
    uniqueIndex("discord_context_mappings_active_npc_unique")
      .on(table.worldId, table.npcId)
      .where(sql`${table.status} = 'active' and ${table.npcId} is not null`),
    foreignKey({
      name: "discord_context_world_fk",
      columns: [table.worldId, table.contextId],
      foreignColumns: [interactionContexts.worldId, interactionContexts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "discord_npc_world_fk",
      columns: [table.worldId, table.npcId],
      foreignColumns: [entities.worldId, entities.id],
    }).onDelete("restrict"),
    index("discord_context_mappings_world_context_idx").on(
      table.worldId,
      table.contextId,
    ),
    index("discord_context_mappings_world_npc_idx").on(
      table.worldId,
      table.npcId,
      table.status,
    ),
  ],
);
