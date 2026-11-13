import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import { discordContextMappings } from "../db/schema/discord-context-mappings.js";
import { discordIdentities } from "../db/schema/discord-identities.js";
import { entities } from "../db/schema/entities.js";
import { entityAliases } from "../db/schema/entity-aliases.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { interactions } from "../db/schema/interactions.js";
import { localPresence } from "../db/schema/local-presence.js";
import { responseDeliveries } from "../db/schema/response-deliveries.js";
import { worlds } from "../db/schema/worlds.js";
import { gatewaySmokeBotId } from "../admin/discord-gateway-smoke.js";
import { assessSceneContact } from "../communication/scene-contact.js";
import { lockLocalContext } from "../communication/local.repository.js";
import { readTrustedHostScenePolicy } from "../communication/scene-speech-policies.repository.js";
import {
  assessOfflineSpeechReadiness,
  type OfflineSpeechReadinessRequest,
} from "../communication/scene-speech-readiness.js";
import { readNpcSummonFacts } from "../communication/summon-facts.repository.js";
import { discordMessageCreatedAt } from "../intake/discord-snowflake.js";
import { parseDiscordTrigger } from "../intake/discord-trigger.js";

// M2.15G: one authoritative PostgreSQL snapshot feeds the existing fake-only
// M2.15D coordinator. This module has NO CLI, Discord client, LLM or outbound
// adapter. It MUST NOT be used to authorize real response generation/sending.
// Intentionally refuse the owner's persistent DEV database, even in test mode.
type Database = Omit<DatabaseClient["db"], "$client">;
const scopeSchema = z
  .object({
    worldId: z.string().uuid(),
    npcId: z.string().uuid(),
    contextId: z.string().uuid(),
    interactionId: z.string().uuid(),
  })
  .strict();
const snowflake = /^\d{17,20}$/u;
const maxAgeMs = 120_000;

function offlineCiOnly(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.DISCORD_ENABLED === "false" &&
    process.env.DISCORD_OUTBOUND_ENABLED === "false" &&
    process.env.LLM_PROVIDER === "disabled"
  );
}

// TEMPORARY CI-only diagnostic: fixed stage codes, no IDs or content.
function diagnosticNull(stage: string): null {
  if (process.env.NODE_ENV === "test")
    console.info("M2_15G_DIAGNOSTIC_" + stage);
  return null;
}

export async function readVerifiedOfflineSpeechSnapshot(
  db: Database,
  raw: unknown,
): Promise<OfflineSpeechReadinessRequest | null> {
  if (!offlineCiOnly()) return diagnosticNull("G1");
  const parsed = scopeSchema.safeParse(raw);
  if (!parsed.success) return diagnosticNull("G2");
  const scope = parsed.data;

  try {
    return await db.transaction(async (tx) => {
      // Verify the authenticated disposable CI principal before querying
      // any world, route or NPC data. Never inspect the owner's DEV world.
      const identity = await tx.execute(
        sql`select current_database() as database, current_user as db_role,
          floor(extract(epoch from clock_timestamp()) * 1000)::bigint as now_ms`,
      );
      const role = identity.rows[0];
      if (
        role?.database !== "living_world_ci" ||
        role.db_role !== "living_world_ci"
      )
        return diagnosticNull("G3");
      const nowMs = Number(role.now_ms);
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) return diagnosticNull("G4");

      // Same lock order as M2.9 context/presence transitions. All reads
      // share one transaction; the trusted-policy reader uses a SAVEPOINT.
      await lockLocalContext(tx, scope);

      const [world] = await tx
        .select({
          key: worlds.key,
          status: worlds.status,
          systemType: worlds.systemType,
        })
        .from(worlds)
        .where(eq(worlds.id, scope.worldId))
        .for("share");
      if (
        !world ||
        world.status !== "active" ||
        world.systemType !== "test" ||
        !world.key.startsWith("npc-gateway-ci-")
      )
        return diagnosticNull("G5");

      const [interaction] = await tx
        .select()
        .from(interactions)
        .where(
          and(
            eq(interactions.id, scope.interactionId),
            eq(interactions.worldId, scope.worldId),
            eq(interactions.npcId, scope.npcId),
            eq(interactions.contextId, scope.contextId),
          ),
        )
        .for("share");
      if (
        !interaction ||
        interaction.status !== "received" ||
        interaction.communicationMode !== "unknown" ||
        interaction.localPresenceId !== null ||
        interaction.responseText !== null ||
        interaction.responseClaimId !== null ||
        interaction.responseMessageId !== null ||
        interaction.sourceProvider !== "discord" ||
        !interaction.sourceMessageId ||
        !interaction.sourceMappingId ||
        !interaction.speakerEntityId ||
        !interaction.sourceGuildId ||
        !interaction.sourceChannelId ||
        !interaction.sourceThreadId
      )
        return diagnosticNull("G6");
      const sourceEventMs = discordMessageCreatedAt(interaction.sourceMessageId);
      if (
        sourceEventMs === null ||
        sourceEventMs > nowMs ||
        nowMs - sourceEventMs > maxAgeMs
      )
        return diagnosticNull("G7");
      const trigger = parseDiscordTrigger(
        interaction.requestText,
        gatewaySmokeBotId,
        [gatewaySmokeBotId],
      );
      if (!trigger) return diagnosticNull("G8");

      const [context] = await tx
        .select()
        .from(interactionContexts)
        .where(
          and(
            eq(interactionContexts.worldId, scope.worldId),
            eq(interactionContexts.id, scope.contextId),
          ),
        )
        .for("share");
      if (
        !context ||
        context.status !== "active" ||
        context.contextType !== "scene" ||
        context.npcIntakePolicy !== "mapped_players" ||
        context.externalProvider !== "discord" ||
        context.externalGuildId !== interaction.sourceGuildId ||
        context.externalChannelId !== interaction.sourceChannelId ||
        context.externalThreadId !== interaction.sourceThreadId ||
        !context.linkedLocationEntityId
      )
        return diagnosticNull("G9");

      // The original immutable route must still be the same active scene.
      // The update-epoch trigger prevents post-event routing changes from
      // silently reviving a previously authorized message.
      const routes = await tx
        .select()
        .from(discordContextMappings)
        .where(
          and(
            eq(discordContextMappings.guildId, interaction.sourceGuildId),
            eq(discordContextMappings.channelId, interaction.sourceChannelId),
          ),
        )
        .limit(2)
        .for("share");
      const route = routes[0];
      if (
        routes.length !== 1 ||
        !route ||
        route.id !== interaction.sourceMappingId ||
        route.worldId !== scope.worldId ||
        route.contextId !== scope.contextId ||
        route.threadId !== interaction.sourceThreadId ||
        route.status !== "active" ||
        route.mappingType !== "scene" ||
        route.npcId !== null ||
        route.updatedAt.getTime() > sourceEventMs
      )
        return diagnosticNull("G10");

      const [player] = await tx
        .select({ status: entities.status, type: entities.entityType })
        .from(entities)
        .where(
          and(
            eq(entities.worldId, scope.worldId),
            eq(entities.id, interaction.speakerEntityId),
          ),
        )
        .for("share");
      if (player?.status !== "active" || player.type !== "player_character")
        return diagnosticNull("G11");

      const identities = await tx
        .select()
        .from(discordIdentities)
        .where(
          and(
            eq(discordIdentities.worldId, scope.worldId),
            eq(discordIdentities.entityId, interaction.speakerEntityId),
          ),
        )
        .limit(2)
        .for("share");
      if (
        identities.length !== 1 ||
        identities[0]!.status !== "active" ||
        identities[0]!.mappingType !== "player_character" ||
        !snowflake.test(identities[0]!.discordUserId) ||
        identities[0]!.discordUserId === gatewaySmokeBotId
      )
        return diagnosticNull("G12");

      // The current alias must resolve uniquely to THIS NPC within this
      // world, not merely exist on the target while another NPC shares it.
      const aliases = await tx
        .select({ entityId: entityAliases.entityId })
        .from(entityAliases)
        .innerJoin(entities, eq(entities.id, entityAliases.entityId))
        .where(
          and(
            eq(entities.worldId, scope.worldId),
            eq(entities.status, "active"),
            eq(entityAliases.normalizedAlias, trigger.alias),
          ),
        )
        .limit(2);
      if (aliases.length !== 1 || aliases[0]!.entityId !== scope.npcId)
        return diagnosticNull("G13");

      const deliveries = await tx
        .select({ id: responseDeliveries.id })
        .from(responseDeliveries)
        .where(eq(responseDeliveries.interactionId, scope.interactionId))
        .limit(1);
      if (deliveries.length) return diagnosticNull("G14");

      const facts = await readNpcSummonFacts(tx, scope);
      if (!facts) return diagnosticNull("G15");
      const presences = await tx
        .select()
        .from(localPresence)
        .where(
          and(
            eq(localPresence.worldId, scope.worldId),
            eq(localPresence.npcId, scope.npcId),
            eq(localPresence.contextId, scope.contextId),
          ),
        )
        .limit(2)
        .for("share");
      if (presences.length !== 1 || presences[0]!.revokedAt) return diagnosticNull("G16");
      const presence = presences[0]!;
      const contact = assessSceneContact({
        worldId: scope.worldId,
        npcId: scope.npcId,
        contextId: scope.contextId,
        facts,
        presence,
        sourceEventMs,
      });
      if (
        contact.path !== "direct_in_scene" ||
        (contact.status !== "needs_review" &&
          contact.status !== "candidate_needs_review")
      )
        return diagnosticNull("G17");

      const approval = await readTrustedHostScenePolicy(tx, {
        worldId: scope.worldId,
        npcId: scope.npcId,
        contextId: scope.contextId,
        presenceId: presence.id,
      });
      if (!approval || approval.issuedByRole !== "host_operator")
        return diagnosticNull("G18");

      const snapshot: OfflineSpeechReadinessRequest = {
        ...scope,
        presenceId: presence.id,
        npcStateVersion: facts.stateVersion,
        sourceMessageId: interaction.sourceMessageId,
        nowMs,
        contact,
        approval,
      };
      // Approval alone is not a real speech authorization. Even this
      // candidate can drive only the injected fake-only Vitest harness.
      if (!assessOfflineSpeechReadiness(snapshot).canRehearseFake)
        return diagnosticNull("G19");
      return snapshot;
    });
  } catch {
    // Never leak Discord IDs, scene content, SQL or secrets in diagnostics.
    return diagnosticNull("G20");
  }
}
