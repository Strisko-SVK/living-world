import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { entities } from "./entities.js";
import { worlds } from "./worlds.js";

export const discordCampaigns = pgTable(
  "discord_campaigns",
  {
    guildId: text("guild_id").primaryKey(),
    worldId: uuid("world_id")
      .notNull()
      .unique()
      .references(() => worlds.id),
    ownerUserId: text("owner_user_id").notNull(),
    categoryId: text("category_id"),
    active: boolean("active").notNull().default(true),
  },
  (t) => [unique("discord_campaign_scope").on(t.guildId, t.worldId)],
);

export const discordCampaignMembers = pgTable(
  "discord_campaign_members",
  {
    worldId: uuid("world_id").notNull(),
    discordUserId: text("discord_user_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    role: text("role", { enum: ["admin", "dm", "player"] }).notNull(),
    active: boolean("active").notNull().default(true),
    authorizedAt: timestamp("authorized_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.discordUserId] }),
    unique("discord_member_entity_unique").on(t.worldId, t.entityId),
    foreignKey({
      name: "discord_member_world_fk",
      columns: [t.worldId, t.entityId],
      foreignColumns: [entities.worldId, entities.id],
    }),
    check(
      "discord_campaign_member_role",
      sql`${t.role} in ('admin','dm','player')`,
    ),
  ],
);

export const discordNpcRegistry = pgTable(
  "discord_npc_registry",
  {
    worldId: uuid("world_id").notNull(),
    npcId: uuid("npc_id").notNull(),
    templateKey: text("template_key").notNull(),
    homeLocationId: uuid("home_location_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.npcId] }),
    unique("discord_registry_template_unique").on(t.worldId, t.templateKey),
    foreignKey({
      name: "discord_registry_npc_fk",
      columns: [t.worldId, t.npcId],
      foreignColumns: [entities.worldId, entities.id],
    }),
    foreignKey({
      name: "discord_registry_home_fk",
      columns: [t.worldId, t.homeLocationId],
      foreignColumns: [entities.worldId, entities.id],
    }),
  ],
);

export const discordRpChannels = pgTable(
  "discord_rp_channels",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    worldId: uuid("world_id").notNull(),
    locationId: uuid("location_id").notNull(),
    baseNpcId: uuid("base_npc_id"),
    active: boolean("active").notNull().default(true),
    enabledAt: timestamp("enabled_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    webhookId: text("webhook_id"),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.channelId] }),
    foreignKey({
      name: "discord_rp_campaign_fk",
      columns: [t.guildId, t.worldId],
      foreignColumns: [discordCampaigns.guildId, discordCampaigns.worldId],
    }),
    foreignKey({
      name: "discord_rp_npc_fk",
      columns: [t.worldId, t.baseNpcId],
      foreignColumns: [discordNpcRegistry.worldId, discordNpcRegistry.npcId],
    }),
    foreignKey({
      name: "discord_rp_location_fk",
      columns: [t.worldId, t.locationId],
      foreignColumns: [entities.worldId, entities.id],
    }),
    uniqueIndex("discord_rp_one_active_base")
      .on(t.worldId, t.baseNpcId)
      .where(sql`${t.active} and ${t.baseNpcId} is not null`),
  ],
);
