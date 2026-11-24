import { and, eq, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../db/client.js";
import {
  discordContextMappings,
  discordIdentities,
  contextIntakePolicyAudit,
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
import {
  lockRouting,
  mapDiscordContext,
  mapDiscordUserToEntity,
} from "../domains/discord-mapping/discord-mapping.repository.js";
import {
  addKnowledgeSource,
  createKnowledge,
} from "../domains/knowledge/knowledge.repository.js";
import { grantLocalPresence } from "../communication/local.repository.js";
import { reconcilePilotPlayer } from "./discord-pilot-player.js";
import { reconcilePilotPolicy } from "./discord-pilot-policy.js";
import type { DevFixtureRoute } from "./discord-dev-fixture.js";

import {
  quartermasterWorldPrefix,
  seedQuartermaster,
  quartermasterPresentation,
  sentinelPresentation,
} from "./quartermaster-profile.js";

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
  const { worldId, contextId, mappingId, npcs, players } = await setupRaonScene(
    db,
    route,
    [playerId],
    worldKey,
  );
  const { npcId, presenceId } = npcs[0];
  return {
    worldKey,
    worldId,
    contextId,
    mappingId,
    npcId,
    presenceId,
    playerEntityId: players[0].entityId,
  };
}

export async function setupRaonScene(
  db: Database,
  route: DevFixtureRoute,
  playerIds: readonly string[],
  worldKey = raonWorldKey,
) {
  const advanced = worldKey === quartermasterWorldPrefix + route.threadId;
  if (
    (!advanced &&
      worldKey !== raonWorldKey &&
      !(
        process.env.NODE_ENV === "test" &&
        /^npc-gateway-ci-[a-f0-9-]{36}$/u.test(worldKey)
      )) ||
    playerIds.length < 1 ||
    playerIds.length > (advanced ? 4 : 1) ||
    new Set(playerIds).size !== playerIds.length ||
    playerIds.some((id) => !/^[1-9][0-9]{16,19}$/u.test(id))
  )
    throw new Error(
      "Only a dedicated Raon fixture and its approved players are permitted.",
    );
  const playerId = playerIds[0];
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '8s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(8202601102)`);
    await lockRouting(tx, ["location", route.guildId, route.channelId]);
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
          advanced
            ? or(
                eq(discordContextMappings.threadId, route.threadId),
                isNull(discordContextMappings.threadId),
              )
            : undefined,
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
      const secondNpc = members.find(
        (entity) =>
          entity.entityType === "npc" &&
          entity.canonicalName === quartermasterPresentation.displayName,
      );
      if (
        members.length !== (advanced ? playerIds.length + 3 : 3) ||
        !npc ||
        !player ||
        (advanced && !secondNpc)
      )
        throw new Error("Raon fixture members changed.");
      const [scene] = await tx
        .select()
        .from(interactionContexts)
        .where(eq(interactionContexts.id, mapping.contextId));
      if (
        !scene ||
        scene.npcIntakePolicy !== "mapped_players" ||
        scene.status !== "active" ||
        scene.externalGuildId !== route.guildId ||
        scene.externalChannelId !== route.channelId ||
        scene.externalThreadId !== route.threadId
      )
        throw new Error("Existing Raon scene is no longer ready.");
      let players;
      if (advanced) {
        const identities = await tx
          .select()
          .from(discordIdentities)
          .where(eq(discordIdentities.worldId, existing.id));
        if (identities.length !== playerIds.length)
          throw new Error(
            "Configured player roster differs from the persisted DEV roster.",
          );
        players = playerIds.map((discordId, index) => {
          const identity = identities.find(
            (row) =>
              row.discordUserId === discordId &&
              row.status === "active" &&
              row.mappingType === "player_character",
          );
          if (
            !identity ||
            !members.some(
              (entity) =>
                entity.id === identity.entityId &&
                entity.entityType === "player_character" &&
                entity.canonicalName ===
                  (index === 0 ? playerName : playerName + " " + (index + 1)),
            )
          )
            throw new Error("Existing Raon player mapping changed.");
          return { discordId, entityId: identity.entityId };
        });
      } else {
        const verified = await reconcilePilotPlayer(tx, {
          worldKey,
          route,
          userId: playerId,
          mode: "preview",
        });
        if (
          verified.event !== "pilot_player_preview" ||
          !("identityStatus" in verified) ||
          verified.identityStatus !== "active"
        )
          throw new Error("Existing Raon player mapping changed.");
        players = [{ discordId: playerId, entityId: player.id }];
      }
      const npcs = [];
      for (const member of [npc, ...(secondNpc ? [secondNpc] : [])]) {
        const [presence] = await tx
          .select()
          .from(localPresence)
          .where(
            and(
              eq(localPresence.worldId, existing.id),
              eq(localPresence.contextId, mapping.contextId),
              eq(localPresence.npcId, member.id),
              isNull(localPresence.revokedAt),
            ),
          );
        if (!presence)
          throw new Error("Existing Raon presence is no longer ready.");
        npcs.push({
          npcId: member.id,
          presenceId: presence.id,
          ...(member.id === npc.id
            ? sentinelPresentation
            : quartermasterPresentation),
        });
      }
      return {
        worldKey,
        worldId: existing.id,
        contextId: mapping.contextId,
        mappingId: mapping.id,
        players,
        npcs,
      };
    }
    if (routes.length)
      throw new Error(
        "Raon requires an unmapped DEV route without a parent fallback.",
      );
    const world = await createWorld(tx, {
      key: worldKey,
      name: advanced
        ? "Wayfarer Ledger DEV"
        : "Living World DEV - Raon Sentinel",
      systemType: "test",
      status: "active",
    });
    const location = await createEntity(tx, world.id, {
      entityType: "location",
      canonicalName: advanced ? "Supply Office, Cargo Deck" : locationName,
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
        ...(advanced && {
          presentation: {
            displayName: sentinelPresentation.displayName,
            avatarUrl: sentinelPresentation.avatarUrl,
          },
        }),
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
            (advanced
              ? "Current station: Supply Office terminal."
              : "Current station: Observation Post A.") +
            " Current gate status: CLOSED. Current alert level: LOW. Last verified observation: a blue crate delivery. Its time and courier are unknown. Sealed command room occupants and entry history are unknown.",
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
    const players = [{ discordId: playerId, entityId: player.id }];
    const targets = [{ npcId: npc.entityId, ...sentinelPresentation }];
    if (advanced) {
      targets.push({
        npcId: await seedQuartermaster(tx, world.id, location.id),
        ...quartermasterPresentation,
      });
      await mapDiscordUserToEntity(tx, world.id, {
        discordUserId: playerId,
        entityId: player.id,
        mappingType: "player_character",
      });
      for (const [index, discordId] of playerIds.slice(1).entries()) {
        const extra = await createEntity(tx, world.id, {
          entityType: "player_character",
          canonicalName: playerName + " " + (index + 2),
        });
        await mapDiscordUserToEntity(tx, world.id, {
          discordUserId: discordId,
          entityId: extra.id,
          mappingType: "player_character",
        });
        players.push({ discordId, entityId: extra.id });
      }
      // This is an initial enable within the new, exact-route synthetic fixture
      // transaction, after enrollment and before any activity has been created.
      await tx
        .update(interactionContexts)
        .set({ npcIntakePolicy: "mapped_players", updatedAt: new Date() })
        .where(eq(interactionContexts.id, scene.id));
      await tx.insert(contextIntakePolicyAudit).values({
        id: randomUUID(),
        worldId: world.id,
        contextId: scene.id,
        previousPolicy: "disabled",
        targetPolicy: "mapped_players",
      });
    } else {
      const enrolled = await reconcilePilotPlayer(tx, {
        worldKey,
        route,
        userId: playerId,
        mode: "enroll",
      });
      if (enrolled.event !== "pilot_player_enrolled")
        throw new Error("Raon player enrollment failed.");
      const policy = await reconcilePilotPolicy(tx, {
        worldKey,
        route,
        mode: "enable",
        confirmedContextId: scene.id,
        testUserId: playerId,
      });
      if (policy.event !== "pilot_policy_changed")
        throw new Error("Raon scene policy setup failed.");
    }
    const npcs = [];
    for (const target of targets) {
      const presence = await grantLocalPresence(tx, {
        worldId: world.id,
        npcId: target.npcId,
        contextId: scene.id,
      });
      if (presence.status !== "granted")
        throw new Error("Raon local presence is unavailable.");
      npcs.push({ ...target, presenceId: presence.evidence.id });
    }
    return {
      worldKey,
      worldId: world.id,
      contextId: scene.id,
      mappingId: mapping.id,
      players,
      npcs,
    };
  });
}
export type RaonFixture = Awaited<ReturnType<typeof setupRaonFixture>>;
export type RaonScene = Awaited<ReturnType<typeof setupRaonScene>>;
