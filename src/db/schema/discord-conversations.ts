import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { entities } from "./entities.js";
import { interactionContexts } from "./interaction-contexts.js";

export const discordConversations = pgTable(
  "discord_conversations",
  {
    worldId: uuid("world_id").notNull(),
    contextId: uuid("context_id").notNull(),
    playerEntityId: uuid("player_entity_id").notNull(),
    npcId: uuid("npc_id"),
    lastSourceId: text("last_source_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.contextId, t.playerEntityId] }),
    foreignKey({
      name: "discord_conversation_context_fk",
      columns: [t.worldId, t.contextId],
      foreignColumns: [interactionContexts.worldId, interactionContexts.id],
    }),
    foreignKey({
      name: "discord_conversation_player_fk",
      columns: [t.worldId, t.playerEntityId],
      foreignColumns: [entities.worldId, entities.id],
    }),
    foreignKey({
      name: "discord_conversation_npc_fk",
      columns: [t.worldId, t.npcId],
      foreignColumns: [entities.worldId, entities.id],
    }),
    check(
      "discord_conversation_source",
      sql`${t.lastSourceId} ~ '^[1-9][0-9]{16,19}$'`,
    ),
  ],
);
