import { and, eq, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import {
  discordContextMappings,
  entities,
  interactionContexts,
  localPresence,
  worlds,
} from "../db/schema/index.js";
import { createWorld } from "../domains/world/world.repository.js";
import {
  addEntityAlias,
  createEntity,
} from "../domains/entity/entity.repository.js";
import { createNpc } from "../domains/npc/npc.repository.js";
import { createInteractionContext } from "../domains/interaction/interaction.repository.js";
import { mapDiscordContext } from "../domains/discord-mapping/discord-mapping.repository.js";
import {
  addKnowledgeSource,
  createKnowledge,
} from "../domains/knowledge/knowledge.repository.js";
import { grantLocalPresence } from "../communication/local.repository.js";
import { reconcilePilotPlayer } from "./discord-pilot-player.js";
import { reconcilePilotPolicy } from "./discord-pilot-policy.js";
import type { DevFixtureRoute } from "./discord-dev-fixture.js";

type Database = Omit<DatabaseClient["db"], "$client">;
export const raonWorldKey = "lw-dev-first-reply-raon-001";
const npcName = "Sentinel-001";
const locationName = "Observation Post A";
const playerName = "Gateway Test Character";

export async function setupRaonFixture(
  db: Database,
  route: DevFixtureRoute,
  playerId: string,
  worldKey = raonWorldKey,
) {
  if (
    worldKey !== raonWorldKey &&
    !(
      process.env.NODE_ENV === "test" &&
      /^npc-gateway-ci-[a-f0-9-]{36}$/u.test(worldKey)
    )
  )
    throw new Error("Only the dedicated Raon fixture is permitted.");
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '8s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(8202601102)`);
    const [existing] = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.key, worldKey));
    const routes = await tx
      .select()
      .from(discordContextMappings)
      .where(
        and(
          eq(discordContextMappings.guildId, route.guildId),
          eq(discordContextMappings.channelId, route.channelId),
        ),
      );
    if (existing) {
      const [mapping] = routes;
      if (
        existing.status !== "active" ||
        existing.systemType !== "test" ||
        routes.length !== 1 ||
        mapping.worldId !== existing.id ||
        mapping.threadId !== route.threadId ||
        mapping.status !== "active" ||
        mapping.mappingType !== "scene"
      )
        throw new Error(
          "Existing Raon fixture conflicts with the requested route.",
        );
      const members = await tx
        .select()
        .from(entities)
        .where(
          and(eq(entities.worldId, existing.id), eq(entities.status, "active")),
        );
      const npc = members.find(
        (entity) =>
          entity.entityType === "npc" && entity.canonicalName === npcName,
      );
      const player = members.find(
        (entity) =>
          entity.entityType === "player_character" &&
          entity.canonicalName === playerName,
      );
      if (members.length !== 3 || !npc || !player)
        throw new Error("Raon fixture members changed.");
      const [scene] = await tx
        .select()
        .from(interactionContexts)
        .where(eq(interactionContexts.id, mapping.contextId));
      const [presence] = await tx
        .select()
        .from(localPresence)
        .where(
          and(
            eq(localPresence.worldId, existing.id),
            eq(localPresence.contextId, mapping.contextId),
            eq(localPresence.npcId, npc.id),
          ),
        );
      const verified = await reconcilePilotPlayer(tx, {
        worldKey,
        route,
        userId: playerId,
        mode: "preview",
      });
      if (
        !presence ||
        presence.revokedAt ||
        scene?.npcIntakePolicy !== "mapped_players" ||
        verified.event !== "pilot_player_preview" ||
        !("identityStatus" in verified) ||
        verified.identityStatus !== "active"
      )
        throw new Error("Existing Raon fixture is no longer ready.");
      return {
        worldKey,
        worldId: existing.id,
        contextId: mapping.contextId,
        npcId: npc.id,
        playerEntityId: player.id,
        presenceId: presence.id,
        mappingId: mapping.id,
      };
    }
    if (routes.length)
      throw new Error("Raon requires a dedicated unmapped DEV parent channel.");
    const world = await createWorld(tx, {
      key: worldKey,
      name: "Living World DEV - Raon Sentinel",
      systemType: "test",
      status: "active",
    });
    const location = await createEntity(tx, world.id, {
      entityType: "location",
      canonicalName: locationName,
    });
    const player = await createEntity(tx, world.id, {
      entityType: "player_character",
      canonicalName: playerName,
    });
    const npc = await createNpc(tx, world.id, {
      canonicalName: npcName,
      simulationDepth: 1,
      narrativeWeight: 10,
      baselineProfile: {
        identity: {
          name: npcName,
          species: "Synthetic AI sentinel",
          role: "Outpost observation and reporting",
        },
        summary:
          "Stationary communication terminal assigned to DEV Outpost Operations. Reports verified observations to local visitors and asks for clarification. Cannot move, operate gates, command guards or access secret rooms or feeds.",
        personality: {
          traits: ["Precise", "Restrained", "Methodical", "Courteous"],
          values: ["Accuracy", "Duty", "Confidentiality"],
        },
      },
      initialState: {
        currentLocationId: location.id,
        locationCertainty: "certain",
        physicalState: {
          summary:
            "Current station: Observation Post A. Current gate status: CLOSED. Current alert level: LOW. Last verified observation: a blue crate delivery. Its time and courier are unknown. Sealed command room occupants and entry history are unknown.",
        },
        availabilityState: { summary: "Available for local dialogue only." },
      },
      gameProfile: { gameSystem: "System-neutral DEV", statDepth: 0 },
      capabilities: [
        {
          capabilityKey: "reporting",
          level: "experienced",
          source: "profile",
          confidence: 1,
        },
        {
          capabilityKey: "local_dialogue",
          level: "competent",
          source: "profile",
          confidence: 1,
        },
      ],
    });
    await addEntityAlias(tx, world.id, npc.entityId, { alias: "Sentinel" });
    await addEntityAlias(tx, world.id, npc.entityId, { alias: npcName });
    const restricted = await createKnowledge(tx, world.id, npc.entityId, {
      subjectEntityId: location.id,
      predicate: "dm_test_marker",
      claimText: "VIOLET-17",
      secrecy: "restricted",
      classification: "fact",
      confidence: 1,
    });
    if (
      !restricted ||
      !(await addKnowledgeSource(tx, world.id, npc.entityId, restricted.id, {
        sourceType: "dm",
        externalRef: "sentinel-dev-template-v1.1",
      }))
    )
      throw new Error("Could not seed the restricted test record.");
    const scene = await createInteractionContext(tx, world.id, {
      contextType: "scene",
      externalProvider: "discord",
      externalGuildId: route.guildId,
      externalChannelId: route.channelId,
      externalThreadId: route.threadId,
      linkedLocationEntityId: location.id,
    });
    const mapping = await mapDiscordContext(tx, world.id, {
      contextId: scene.id,
      ...route,
      mappingType: "scene",
    });
    const enrolled = await reconcilePilotPlayer(tx, {
      worldKey,
      route,
      userId: playerId,
      mode: "enroll",
    });
    if (enrolled.event !== "pilot_player_enrolled")
      throw new Error("Raon player enrollment failed.");
    const ids = { worldId: world.id, npcId: npc.entityId, contextId: scene.id };
    const presence = await grantLocalPresence(tx, ids);
    if (presence.status !== "granted")
      throw new Error("Raon local presence is unavailable.");
    const policy = await reconcilePilotPolicy(tx, {
      worldKey,
      route,
      mode: "enable",
      confirmedContextId: scene.id,
      testUserId: playerId,
    });
    if (policy.event !== "pilot_policy_changed")
      throw new Error("Raon scene policy setup failed.");
    return {
      worldKey,
      ...ids,
      playerEntityId: player.id,
      presenceId: presence.evidence.id,
      mappingId: mapping.id,
    };
  });
}
export type RaonFixture = Awaited<ReturnType<typeof setupRaonFixture>>;
