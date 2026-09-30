import { randomUUID } from "node:crypto";

import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createDatabaseClient } from "./client.js";
import { discordContextMappings } from "./schema/discord-context-mappings.js";
import { discordIdentities } from "./schema/discord-identities.js";
import { entities } from "./schema/entities.js";
import { interactionContexts } from "./schema/interaction-contexts.js";
import { npcCapabilities } from "./schema/npc-capabilities.js";
import { npcGameProfiles } from "./schema/npc-game-profiles.js";
import { npcState } from "./schema/npc-state.js";
import { npcs } from "./schema/npcs.js";
import { worlds } from "./schema/worlds.js";
import { createEntity } from "../domains/entity/entity.repository.js";
import {
  getContextByDiscordLocation,
  getNpcPrimaryContext,
  listDiscordUserMappings,
  mapDiscordContext,
  mapDiscordUserToEntity,
  resolveDiscordUserEntities,
  setNpcPrimaryContext,
  setPrimaryDiscordEntity,
} from "../domains/discord-mapping/discord-mapping.repository.js";
import { peloDiscordPrimarySpaceFixture } from "../domains/discord-mapping/discord-mapping.test-fixture.js";
import { createInteractionContext } from "../domains/interaction/interaction.repository.js";
import { createNpc, getNpcWithState } from "../domains/npc/npc.repository.js";
import { peloNpcFixture } from "../domains/npc/npc.test-fixture.js";
import { createWorld } from "../domains/world/world.repository.js";

const database = createDatabaseClient();
const worldIds: string[] = [];
const entityIds: string[] = [];
const npcIds: string[] = [];
const contextIds: string[] = [];
const identityIds: string[] = [];
const contextMappingIds: string[] = [];

afterAll(async () => {
  try {
    if (contextMappingIds.length)
      await database.db
        .delete(discordContextMappings)
        .where(inArray(discordContextMappings.id, contextMappingIds));
    if (identityIds.length)
      await database.db
        .delete(discordIdentities)
        .where(inArray(discordIdentities.id, identityIds));
    if (contextIds.length)
      await database.db
        .delete(interactionContexts)
        .where(inArray(interactionContexts.id, contextIds));
    if (npcIds.length) {
      await database.db
        .delete(npcCapabilities)
        .where(inArray(npcCapabilities.npcId, npcIds));
      await database.db
        .delete(npcGameProfiles)
        .where(inArray(npcGameProfiles.npcId, npcIds));
      await database.db.delete(npcState).where(inArray(npcState.npcId, npcIds));
      await database.db.delete(npcs).where(inArray(npcs.entityId, npcIds));
    }
    if (entityIds.length)
      await database.db.delete(entities).where(inArray(entities.id, entityIds));
    if (worldIds.length)
      await database.db.delete(worlds).where(inArray(worlds.id, worldIds));
  } finally {
    await database.close();
  }
});

describe("Discord identity and context mappings", () => {
  it("keeps identity, context routing, and NPC primary spaces world-scoped", async () => {
    const suffix = randomUUID();
    const worldA = await createWorld(database.db, {
      key: `discord-a-${suffix}`,
      name: "Discord World A",
      systemType: "test",
    });
    const worldB = await createWorld(database.db, {
      key: `discord-b-${suffix}`,
      name: "Discord World B",
      systemType: "test",
    });
    worldIds.push(worldA.id, worldB.id);
    const pelo = await createNpc(database.db, worldA.id, peloNpcFixture);
    const foreignPelo = await createNpc(database.db, worldB.id, {
      ...peloNpcFixture,
      canonicalName: `Foreign Pel\`o ${suffix}`,
    });
    npcIds.push(pelo.entityId, foreignPelo.entityId);
    entityIds.push(pelo.entityId, foreignPelo.entityId);
    const garak = await createEntity(database.db, worldA.id, {
      entityType: "player_character",
      canonicalName: `Garak ${suffix}`,
    });
    const garakAlt = await createEntity(database.db, worldA.id, {
      entityType: "player_character",
      canonicalName: `Garak Alt ${suffix}`,
    });
    const foreignGarak = await createEntity(database.db, worldB.id, {
      entityType: "player_character",
      canonicalName: `Foreign Garak ${suffix}`,
    });
    const location = await createEntity(database.db, worldA.id, {
      entityType: "location",
      canonicalName: `Docking Bay ${suffix}`,
    });
    entityIds.push(garak.id, garakAlt.id, foreignGarak.id, location.id);

    const firstIdentity = await mapDiscordUserToEntity(database.db, worldA.id, {
      discordUserId: "synthetic-user-garak",
      entityId: garak.id,
      mappingType: "player_character",
      isPrimary: true,
    });
    const secondIdentity = await mapDiscordUserToEntity(
      database.db,
      worldA.id,
      {
        discordUserId: "synthetic-user-garak",
        entityId: garakAlt.id,
        mappingType: "player_character",
      },
    );
    identityIds.push(firstIdentity.id, secondIdentity.id);
    await expect(
      mapDiscordUserToEntity(database.db, worldA.id, {
        discordUserId: "synthetic-user-garak",
        entityId: foreignGarak.id,
        mappingType: "player_character",
      }),
    ).rejects.toThrow("Mapped entity was not found");
    await expect(
      resolveDiscordUserEntities(
        database.db,
        worldA.id,
        "synthetic-user-garak",
      ),
    ).resolves.toEqual([
      expect.objectContaining({ id: garak.id }),
      expect.objectContaining({ id: garakAlt.id }),
    ]);
    await expect(
      setPrimaryDiscordEntity(
        database.db,
        worldA.id,
        "synthetic-user-garak",
        garakAlt.id,
      ),
    ).resolves.toMatchObject({ entityId: garakAlt.id, isPrimary: true });
    await expect(
      listDiscordUserMappings(database.db, worldA.id, "synthetic-user-garak"),
    ).resolves.toEqual([
      expect.objectContaining({ entityId: garakAlt.id, isPrimary: true }),
      expect.objectContaining({ entityId: garak.id, isPrimary: false }),
    ]);

    const channelContext = await createInteractionContext(
      database.db,
      worldA.id,
      { contextType: "scene", linkedLocationEntityId: location.id },
    );
    const threadContext = await createInteractionContext(
      database.db,
      worldA.id,
      { contextType: "scene" },
    );
    const secondThreadContext = await createInteractionContext(
      database.db,
      worldA.id,
      { contextType: "npc_primary" },
    );
    const foreignContext = await createInteractionContext(
      database.db,
      worldB.id,
      { contextType: "scene" },
    );
    contextIds.push(
      channelContext.id,
      threadContext.id,
      secondThreadContext.id,
      foreignContext.id,
    );
    const before = await getNpcWithState(database.db, worldA.id, pelo.entityId);
    const channelMapping = await mapDiscordContext(database.db, worldA.id, {
      contextId: channelContext.id,
      guildId: peloDiscordPrimarySpaceFixture.guildId,
      channelId: peloDiscordPrimarySpaceFixture.channelId,
      mappingType: "scene",
    });
    const threadMapping = await mapDiscordContext(database.db, worldA.id, {
      contextId: threadContext.id,
      ...peloDiscordPrimarySpaceFixture,
      mappingType: "scene",
    });
    const secondThreadMapping = await mapDiscordContext(
      database.db,
      worldA.id,
      {
        contextId: secondThreadContext.id,
        guildId: "test-guild-pelo",
        channelId: "test-channel-pelo-secondary",
        threadId: "test-thread-pelo-secondary",
        mappingType: "scene",
      },
    );
    contextMappingIds.push(
      channelMapping.id,
      threadMapping.id,
      secondThreadMapping.id,
    );
    await expect(
      mapDiscordContext(database.db, worldA.id, {
        contextId: foreignContext.id,
        guildId: "foreign-guild",
        channelId: "foreign-channel",
        mappingType: "scene",
      }),
    ).rejects.toThrow("Interaction context was not found");
    await expect(
      getContextByDiscordLocation(
        database.db,
        worldA.id,
        peloDiscordPrimarySpaceFixture.guildId,
        peloDiscordPrimarySpaceFixture.channelId,
        peloDiscordPrimarySpaceFixture.threadId,
      ),
    ).resolves.toMatchObject({ id: threadContext.id });
    await expect(
      getContextByDiscordLocation(
        database.db,
        worldA.id,
        peloDiscordPrimarySpaceFixture.guildId,
        peloDiscordPrimarySpaceFixture.channelId,
      ),
    ).resolves.toMatchObject({ id: channelContext.id });

    await expect(
      setNpcPrimaryContext(
        database.db,
        worldB.id,
        pelo.entityId,
        threadContext.id,
      ),
    ).resolves.toBeNull();
    await expect(
      setNpcPrimaryContext(
        database.db,
        worldA.id,
        pelo.entityId,
        foreignContext.id,
      ),
    ).rejects.toThrow("Interaction context was not found");
    await expect(
      setNpcPrimaryContext(
        database.db,
        worldA.id,
        pelo.entityId,
        threadContext.id,
      ),
    ).resolves.toMatchObject({
      contextId: threadContext.id,
      mappingType: "npc_primary",
    });
    await expect(
      getNpcPrimaryContext(database.db, worldA.id, pelo.entityId),
    ).resolves.toMatchObject({ id: threadContext.id });
    await expect(
      setNpcPrimaryContext(
        database.db,
        worldA.id,
        pelo.entityId,
        secondThreadContext.id,
      ),
    ).resolves.toMatchObject({ contextId: secondThreadContext.id });
    await expect(
      getNpcPrimaryContext(database.db, worldA.id, pelo.entityId),
    ).resolves.toMatchObject({ id: secondThreadContext.id });
    const after = await getNpcWithState(database.db, worldA.id, pelo.entityId);
    expect(after?.state).toEqual(before?.state);
  });
});
