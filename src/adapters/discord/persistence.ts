import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { discordContextMappings } from "../../db/schema/discord-context-mappings.js";
import { worlds } from "../../db/schema/worlds.js";
import {
  getContextByDiscordLocation,
  listDiscordUserMappings,
  lockRouting,
} from "../../domains/discord-mapping/discord-mapping.repository.js";
import {
  findEntitiesByAlias,
  lockEntityAlias,
  getEntity,
} from "../../domains/entity/entity.repository.js";
import { getNpc } from "../../domains/npc/npc.repository.js";
import { createInteraction } from "../../domains/interaction/interaction.repository.js";
import {
  incomingMessageSchema,
  intakeAllowlistSchema,
  resolveSpeaker,
  type IntakePersistence,
  type IntakeGrant,
} from "../../intake/discord-intake.js";
import { parseDiscordTrigger } from "../../intake/discord-trigger.js";
import { discordIdentities } from "../../db/schema/discord-identities.js";
import { entities } from "../../db/schema/entities.js";
import { npcs } from "../../db/schema/npcs.js";
import { interactions } from "../../db/schema/interactions.js";
import { interactionContexts } from "../../db/schema/interaction-contexts.js";

type Database = Omit<DatabaseClient["db"], "$client">;

export function createDiscordPersistence(
  database: Database,
  allowlist: readonly IntakeGrant[] = [],
): IntakePersistence {
  // Immutable startup policy snapshot. Revocation requires restarting all intake
  // instances with the new operator configuration, not changing Discord metadata.
  const policy = intakeAllowlistSchema.parse(allowlist);
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
      return database.transaction(async (transaction) => {
        let bound;
        if ("trigger" in input) {
          await transaction.execute(sql`set local lock_timeout='2s'`);
          await transaction.execute(sql`set local statement_timeout='5s'`);
          const parsed = incomingMessageSchema.safeParse(input.message);
          if (!parsed.success) return "unsupported";
          const message = parsed.data;
          const trigger = parseDiscordTrigger(
            message.content,
            input.trigger.botId,
            message.mentionedUserIds,
          );
          if (!trigger) return "invalid_trigger";
          await lockRouting(transaction, [
            "location",
            message.guildId,
            message.channelId,
          ]);
          const routes = await transaction
            .select()
            .from(discordContextMappings)
            .where(
              and(
                eq(discordContextMappings.guildId, message.guildId),
                eq(discordContextMappings.channelId, message.channelId),
              ),
            )
            .orderBy(discordContextMappings.id)
            .for("share");
          const worldIds = [...new Set(routes.map((row) => row.worldId))];
          if (worldIds.length)
            await transaction
              .select()
              .from(worlds)
              .where(inArray(worlds.id, worldIds))
              .orderBy(worlds.id)
              .for("share");
          const scoped = createDiscordPersistence(transaction, policy);
          const candidates = await scoped.worldIds(message);
          if (candidates.length !== 1)
            return candidates.length ? "ambiguous_world" : "unmapped";
          const worldId = candidates[0];
          const context = await scoped.context(worldId, message);
          if (!context) return "unmapped";
          const [scene] = await transaction
            .select()
            .from(interactionContexts)
            .where(
              and(
                eq(interactionContexts.id, context.id),
                eq(interactionContexts.worldId, worldId),
              ),
            )
            .for("share");
          if (!scene || scene.status !== "active") return "unmapped";
          // Visibility, identity, mentions and arbitrary context metadata confer
          // no permission. Evaluate the explicit tuple inside this transaction.
          if (
            !policy.some(
              (grant) =>
                grant.worldId === worldId &&
                grant.contextId === scene.id &&
                grant.authorId === message.authorId,
            )
          )
            return "unauthorized";
          await lockRouting(transaction, [
            "discord-event",
            worldId,
            "discord",
            message.sourceMessageId,
          ]);
          await lockRouting(transaction, [
            "identity",
            worldId,
            message.authorId,
          ]);
          const identities = await transaction
            .select()
            .from(discordIdentities)
            .where(
              and(
                eq(discordIdentities.worldId, worldId),
                eq(discordIdentities.discordUserId, message.authorId),
              ),
            )
            .orderBy(discordIdentities.id)
            .for("share");
          const identityIds = [
            ...new Set(identities.map((row) => row.entityId)),
          ];
          if (identityIds.length)
            await transaction
              .select()
              .from(entities)
              .where(
                and(
                  eq(entities.worldId, worldId),
                  inArray(entities.id, identityIds),
                ),
              )
              .orderBy(entities.id)
              .for("share");
          const speakerEntityId = resolveSpeaker(
            await scoped.identities(worldId, message.authorId),
          );
          if (speakerEntityId === false) return "ambiguous_speaker";
          await lockEntityAlias(transaction, worldId, trigger.alias);
          const matches = await findEntitiesByAlias(
            transaction,
            worldId,
            trigger.alias,
            true,
          );
          const targetIds = [...new Set(matches.map((row) => row.id))];
          if (targetIds.length !== 1)
            return targetIds.length ? "ambiguous_target" : "invalid_target";
          const npcId = targetIds[0];
          await transaction
            .select()
            .from(npcs)
            .where(eq(npcs.entityId, npcId))
            .for("share");
          if (!(await scoped.isNpc(worldId, npcId))) return "invalid_target";
          // Existing per-NPC uniqueness alone would allow another target after
          // alias reassignment. Bind strict retries to the original scoped event.
          const prior = await transaction
            .select()
            .from(interactions)
            .where(
              and(
                eq(interactions.worldId, worldId),
                eq(interactions.sourceProvider, "discord"),
                eq(interactions.sourceMessageId, message.sourceMessageId),
              ),
            )
            .limit(2)
            .for("update");
          if (prior.length) {
            return prior.length === 1 &&
              prior[0].npcId === npcId &&
              prior[0].contextId === scene.id &&
              prior[0].speakerEntityId === speakerEntityId &&
              prior[0].requestText === message.content
              ? "duplicate"
              : "event_conflict";
          }
          bound = {
            worldId,
            contextId: scene.id,
            speakerEntityId,
            npcIds: [npcId],
            message,
          };
        } else bound = input;
        for (const npcId of bound.npcIds) {
          const interaction = await createInteraction(
            transaction,
            bound.worldId,
            npcId,
            {
              contextId: bound.contextId,
              speakerEntityId: bound.speakerEntityId,
              sourceProvider: "discord",
              sourceMessageId: bound.message.sourceMessageId,
              traceId: input.traceId,
              requestText: bound.message.content,
              interactionType: "social",
              communicationMode: "unknown",
            },
          );
          if (!interaction)
            throw new Error("Discord intake target is no longer available.");
        }
        return "trigger" in input ? "accepted" : undefined;
      });
    },
  };
}
