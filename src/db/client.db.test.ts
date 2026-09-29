import { randomUUID } from "node:crypto";

import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { checkDatabaseConnection, createDatabaseClient } from "./client.js";
import { entityAliases } from "./schema/entity-aliases.js";
import { entities } from "./schema/entities.js";
import { npcCapabilities } from "./schema/npc-capabilities.js";
import { npcGameProfiles } from "./schema/npc-game-profiles.js";
import { npcState } from "./schema/npc-state.js";
import { npcs } from "./schema/npcs.js";
import { worlds } from "./schema/worlds.js";
import {
  addEntityAlias,
  createEntity,
  findEntitiesByAlias,
  findEntityByCanonicalName,
  getEntity,
} from "../domains/entity/entity.repository.js";
import {
  createNpc,
  getNpc,
  getNpcGameProfile,
  getNpcWithState,
  listNpcCapabilities,
  NpcStateVersionConflictError,
  updateNpcState,
  upsertNpcCapability,
  upsertNpcGameProfile,
} from "../domains/npc/npc.repository.js";
import { peloNpcFixture } from "../domains/npc/npc.test-fixture.js";
import { createWorld } from "../domains/world/world.repository.js";

const database = createDatabaseClient();
const worldIds: string[] = [];
const entityIds: string[] = [];
const aliasIds: string[] = [];
const npcIds: string[] = [];

afterAll(async () => {
  try {
    if (npcIds.length > 0) {
      await database.db
        .delete(npcCapabilities)
        .where(inArray(npcCapabilities.npcId, npcIds));
      await database.db
        .delete(npcGameProfiles)
        .where(inArray(npcGameProfiles.npcId, npcIds));
      await database.db.delete(npcState).where(inArray(npcState.npcId, npcIds));
      await database.db.delete(npcs).where(inArray(npcs.entityId, npcIds));
    }

    if (aliasIds.length > 0) {
      await database.db
        .delete(entityAliases)
        .where(inArray(entityAliases.id, aliasIds));
    }

    if (entityIds.length > 0) {
      await database.db.delete(entities).where(inArray(entities.id, entityIds));
    }

    if (worldIds.length > 0) {
      await database.db.delete(worlds).where(inArray(worlds.id, worldIds));
    }
  } finally {
    await database.close();
  }
});

describe("database connection", () => {
  it("executes SELECT 1 through Drizzle", async () => {
    await expect(checkDatabaseConnection(database)).resolves.toBe(true);
  });

  it("keeps entity reads and aliases scoped to their world", async () => {
    const suffix = randomUUID();
    const worldA = await createWorld(database.db, {
      key: `integration-a-${suffix}`,
      name: "Integration World A",
      systemType: "test",
    });
    worldIds.push(worldA.id);
    const worldB = await createWorld(database.db, {
      key: `integration-b-${suffix}`,
      name: "Integration World B",
      systemType: "test",
    });
    worldIds.push(worldB.id);

    const entityA = await createEntity(database.db, worldA.id, {
      entityType: "npc",
      canonicalName: "Seneschal Garak",
    });
    entityIds.push(entityA.id);
    const entityA2 = await createEntity(database.db, worldA.id, {
      entityType: "organization",
      canonicalName: "Garak Household",
    });
    entityIds.push(entityA2.id);
    const entityB = await createEntity(database.db, worldB.id, {
      entityType: "npc",
      canonicalName: "Seneschal Voss",
    });
    entityIds.push(entityB.id);

    await expect(
      getEntity(database.db, worldA.id, entityA.id),
    ).resolves.toMatchObject({
      id: entityA.id,
    });
    await expect(
      getEntity(database.db, worldB.id, entityA.id),
    ).resolves.toBeNull();

    await expect(
      findEntityByCanonicalName(database.db, worldA.id, "Seneschal Garak"),
    ).resolves.toMatchObject({ id: entityA.id });
    await expect(
      findEntityByCanonicalName(database.db, worldB.id, "Seneschal Garak"),
    ).resolves.toBeNull();

    const aliasA = await addEntityAlias(database.db, worldA.id, entityA.id, {
      alias: "  Seneschal   Garak ",
    });
    aliasIds.push(aliasA.id);
    const aliasA2 = await addEntityAlias(database.db, worldA.id, entityA2.id, {
      alias: "Seneschal Garak",
    });
    aliasIds.push(aliasA2.id);
    const aliasB = await addEntityAlias(database.db, worldB.id, entityB.id, {
      alias: "Seneschal Garak",
    });
    aliasIds.push(aliasB.id);

    await expect(
      addEntityAlias(database.db, worldA.id, entityA.id, {
        alias: "seneschal garak",
      }),
    ).rejects.toThrow();
    await expect(
      addEntityAlias(database.db, worldB.id, entityA.id, {
        alias: "cross-world",
      }),
    ).rejects.toThrow("Entity was not found in the specified world.");

    const worldAAliases = await findEntitiesByAlias(
      database.db,
      worldA.id,
      "seneschal garak",
    );
    expect(worldAAliases.map((entity) => entity.id)).toEqual(
      expect.arrayContaining([entityA.id, entityA2.id]),
    );
    expect(worldAAliases.map((entity) => entity.id)).not.toContain(entityB.id);

    const worldBAliases = await findEntitiesByAlias(
      database.db,
      worldB.id,
      "seneschal garak",
    );
    expect(worldBAliases.map((entity) => entity.id)).toEqual([entityB.id]);
    expect(worldBAliases.map((entity) => entity.id)).not.toContain(entityA.id);
  });

  it("persists NPC data transactionally and enforces world-scoped updates", async () => {
    const suffix = randomUUID();
    const worldA = await createWorld(database.db, {
      key: `npc-integration-a-${suffix}`,
      name: "NPC Integration World A",
      systemType: "test",
    });
    worldIds.push(worldA.id);
    const worldB = await createWorld(database.db, {
      key: `npc-integration-b-${suffix}`,
      name: "NPC Integration World B",
      systemType: "test",
    });
    worldIds.push(worldB.id);

    const npc = await createNpc(database.db, worldA.id, peloNpcFixture);
    entityIds.push(npc.entityId);
    npcIds.push(npc.entityId);

    await expect(
      getNpc(database.db, worldA.id, npc.entityId),
    ).resolves.toMatchObject({
      entityId: npc.entityId,
      canonicalName: peloNpcFixture.canonicalName,
      profileVersion: 1,
    });
    await expect(
      getNpc(database.db, worldB.id, npc.entityId),
    ).resolves.toBeNull();

    const nonNpcEntity = await createEntity(database.db, worldA.id, {
      entityType: "organization",
      canonicalName: "Not an NPC",
    });
    entityIds.push(nonNpcEntity.id);
    await expect(
      getNpc(database.db, worldA.id, nonNpcEntity.id),
    ).resolves.toBeNull();

    const initialNpc = await getNpcWithState(
      database.db,
      worldA.id,
      npc.entityId,
    );
    expect(initialNpc?.state).toMatchObject({
      version: 1,
      locationCertainty: "certain",
    });

    const updatedState = await updateNpcState(
      database.db,
      worldA.id,
      npc.entityId,
      {
        expectedVersion: 1,
        availabilityState: { summary: "Reviewing requisition ledgers." },
      },
    );
    expect(updatedState).toMatchObject({ version: 2 });
    await expect(
      getNpc(database.db, worldA.id, npc.entityId),
    ).resolves.toMatchObject({
      profileVersion: 1,
    });
    await expect(
      updateNpcState(database.db, worldA.id, npc.entityId, {
        expectedVersion: 1,
        emotionalState: { summary: "Irritated." },
      }),
    ).rejects.toBeInstanceOf(NpcStateVersionConflictError);
    await expect(
      updateNpcState(database.db, worldB.id, npc.entityId, {
        emotionalState: { summary: "Ignored." },
      }),
    ).resolves.toBeNull();

    const initialGameProfile = await getNpcGameProfile(
      database.db,
      worldA.id,
      npc.entityId,
    );
    expect(initialGameProfile).toMatchObject({
      gameSystem: "mixed_dh_rt",
      version: 1,
    });
    const updatedGameProfile = await upsertNpcGameProfile(
      database.db,
      worldA.id,
      npc.entityId,
      {
        ...peloNpcFixture.gameProfile!,
        statDepth: 2,
      },
    );
    expect(updatedGameProfile).toMatchObject({ statDepth: 2, version: 2 });
    await expect(
      getNpcGameProfile(database.db, worldB.id, npc.entityId),
    ).resolves.toBeNull();

    const initialCapabilities = await listNpcCapabilities(
      database.db,
      worldA.id,
      npc.entityId,
    );
    expect(initialCapabilities).toHaveLength(3);
    const updatedCapability = await upsertNpcCapability(
      database.db,
      worldA.id,
      npc.entityId,
      {
        capabilityKey: "bureaucracy",
        level: "experienced",
        source: "manual",
        confidence: 1,
      },
    );
    expect(updatedCapability).toMatchObject({
      level: "experienced",
      confidence: 1,
    });
    const capabilities = await listNpcCapabilities(
      database.db,
      worldA.id,
      npc.entityId,
    );
    expect(capabilities).toHaveLength(3);
    expect(
      capabilities.find(
        (capability) => capability.capabilityKey === "bureaucracy",
      ),
    ).toMatchObject({ level: "experienced", source: "manual", confidence: 1 });
    await expect(
      listNpcCapabilities(database.db, worldB.id, npc.entityId),
    ).resolves.toEqual([]);

    const rollbackCanonicalName = `Rollback NPC ${suffix}`;
    await expect(
      createNpc(database.db, worldA.id, {
        ...peloNpcFixture,
        canonicalName: rollbackCanonicalName,
        baselineProfile: {
          ...peloNpcFixture.baselineProfile,
          identity: {
            ...peloNpcFixture.baselineProfile.identity,
            name: rollbackCanonicalName,
          },
        },
        capabilities: [
          {
            capabilityKey: "duplicate_capability",
            level: "basic",
            source: "manual",
            confidence: 1,
          },
          {
            capabilityKey: "duplicate_capability",
            level: "expert",
            source: "manual",
            confidence: 1,
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      findEntityByCanonicalName(database.db, worldA.id, rollbackCanonicalName),
    ).resolves.toBeNull();
  });
});
