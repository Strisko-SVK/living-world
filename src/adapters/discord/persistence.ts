import { and, eq, isNull, or } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { discordContextMappings } from "../../db/schema/discord-context-mappings.js";
import { worlds } from "../../db/schema/worlds.js";
import {
  getContextByDiscordLocation,
  listDiscordUserMappings,
} from "../../domains/discord-mapping/discord-mapping.repository.js";
import { getEntity } from "../../domains/entity/entity.repository.js";
import { getNpc } from "../../domains/npc/npc.repository.js";
import { createInteraction } from "../../domains/interaction/interaction.repository.js";
import type { IntakePersistence } from "../../intake/discord-intake.js";

export function createDiscordPersistence(
  database: DatabaseClient["db"],
): IntakePersistence {
  return {
    async worldIds(message) {
      const rows = await database
        .select({ worldId: discordContextMappings.worldId })
        .from(discordContextMappings)
        .innerJoin(worlds, eq(worlds.id, discordContextMappings.worldId))
        .where(
          and(
            eq(worlds.status, "active"),
            eq(discordContextMappings.status, "active"),
            eq(discordContextMappings.guildId, message.guildId),
            eq(discordContextMappings.channelId, message.channelId),
            message.threadId
              ? or(
                  eq(discordContextMappings.threadId, message.threadId),
                  isNull(discordContextMappings.threadId),
                )
              : isNull(discordContextMappings.threadId),
          ),
        );
      return [...new Set(rows.map((row) => row.worldId))];
    },
    context: (worldId, message) =>
      getContextByDiscordLocation(
        database,
        worldId,
        message.guildId,
        message.channelId,
        message.threadId,
      ),
    async identities(worldId, userId) {
      const mappings = await listDiscordUserMappings(
        database,
        worldId,
        userId,
        "active",
      );
      const eligible = await Promise.all(
        mappings.map(async (mapping) => {
          const entity = await getEntity(database, worldId, mapping.entityId);
          return entity?.status === "active" ? mapping : null;
        }),
      );
      return eligible.filter((mapping) => mapping !== null);
    },
    async isNpc(worldId, entityId) {
      const [npc, entity] = await Promise.all([
        getNpc(database, worldId, entityId),
        getEntity(database, worldId, entityId),
      ]);
      return (
        !!npc && npc.lifecycleState === "active" && entity?.status === "active"
      );
    },
    async primaryNpcs(worldId, contextId) {
      const rows = await database
        .select({ npcId: discordContextMappings.npcId })
        .from(discordContextMappings)
        .where(
          and(
            eq(discordContextMappings.worldId, worldId),
            eq(discordContextMappings.contextId, contextId),
            eq(discordContextMappings.status, "active"),
            eq(discordContextMappings.mappingType, "npc_primary"),
          ),
        );
      return rows.flatMap((row) => (row.npcId ? [row.npcId] : []));
    },
    async persist(input) {
      // One event's explicit targets commit together, including under retries.
      await database.transaction(async (transaction) => {
        for (const npcId of input.npcIds) {
          const interaction = await createInteraction(
            transaction,
            input.worldId,
            npcId,
            {
              contextId: input.contextId,
              speakerEntityId: input.speakerEntityId,
              sourceProvider: "discord",
              sourceMessageId: input.message.sourceMessageId,
              traceId: input.traceId,
              requestText: input.message.content,
              interactionType: "social",
              communicationMode: "unknown",
            },
          );
          if (!interaction)
            throw new Error("Discord intake target is no longer available.");
        }
      });
    },
  };
}
