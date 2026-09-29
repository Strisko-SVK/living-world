import { randomUUID } from "node:crypto";

import { inArray, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { checkDatabaseConnection, createDatabaseClient } from "./client.js";
import { entityAliases } from "./schema/entity-aliases.js";
import { entities } from "./schema/entities.js";
import { npcCapabilities } from "./schema/npc-capabilities.js";
import { npcGameProfiles } from "./schema/npc-game-profiles.js";
import { npcState } from "./schema/npc-state.js";
import { memoryRelations } from "./schema/memory-relations.js";
import { memorySources } from "./schema/memory-sources.js";
import { knowledgeConflicts } from "./schema/knowledge-conflicts.js";
import { knowledgeSources } from "./schema/knowledge-sources.js";
import { npcKnowledge } from "./schema/npc-knowledge.js";
import { npcMemories } from "./schema/npc-memories.js";
import { npcs } from "./schema/npcs.js";
import { relationshipEvents } from "./schema/relationship-events.js";
import { relationships } from "./schema/relationships.js";
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
import { peloMemoryFixtures } from "../domains/memory/memory.test-fixture.js";
import { peloKnowledgeFixtures } from "../domains/knowledge/knowledge.test-fixture.js";
import {
  peloSeverianTaskEventFixture,
  peloToSeverianRelationshipFixture,
} from "../domains/relationship/relationship.test-fixture.js";
import {
  addKnowledgeSource,
  createKnowledge,
  createKnowledgeConflict,
  getKnowledge,
  listKnowledge,
  listKnowledgeConflicts,
  listKnowledgeSources,
  updateKnowledgeConfidence,
  updateKnowledgeStatus,
} from "../domains/knowledge/knowledge.repository.js";
import {
  addMemoryRelation,
  addMemorySource,
  createMemory,
  getMemory,
  listMemories,
  listMemoryRelations,
  listMemorySources,
  updateMemoryStatus,
} from "../domains/memory/memory.repository.js";
import {
  applyRelationshipEvent,
  createRelationship,
  getRelationship,
  listRelationshipEvents,
  listRelationshipsFrom,
  listRelationshipsTo,
  RelationshipVersionConflictError,
  updateRelationshipIntent,
} from "../domains/relationship/relationship.repository.js";
import { createWorld } from "../domains/world/world.repository.js";

const database = createDatabaseClient();
const worldIds: string[] = [];
const entityIds: string[] = [];
const aliasIds: string[] = [];
const npcIds: string[] = [];
const memoryIds: string[] = [];
const knowledgeIds: string[] = [];
const relationshipIds: string[] = [];

afterAll(async () => {
  try {
    if (relationshipIds.length > 0) {
      await database.db
        .delete(relationshipEvents)
        .where(inArray(relationshipEvents.relationshipId, relationshipIds));
      await database.db
        .delete(relationships)
        .where(inArray(relationships.id, relationshipIds));
    }

    if (knowledgeIds.length > 0) {
      await database.db
        .delete(knowledgeConflicts)
        .where(
          or(
            inArray(knowledgeConflicts.claimAId, knowledgeIds),
            inArray(knowledgeConflicts.claimBId, knowledgeIds),
          ),
        );
      await database.db
        .delete(knowledgeSources)
        .where(inArray(knowledgeSources.knowledgeId, knowledgeIds));
      await database.db
        .delete(npcKnowledge)
        .where(inArray(npcKnowledge.id, knowledgeIds));
    }

    if (memoryIds.length > 0) {
      await database.db
        .delete(memoryRelations)
        .where(
          or(
            inArray(memoryRelations.parentMemoryId, memoryIds),
            inArray(memoryRelations.childMemoryId, memoryIds),
          ),
        );
      await database.db
        .delete(memorySources)
        .where(inArray(memorySources.memoryId, memoryIds));
      await database.db
        .delete(npcMemories)
        .where(inArray(npcMemories.id, memoryIds));
    }

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

  it("persists NPC memories with scoped provenance and relations", async () => {
    const suffix = randomUUID();
    const worldA = await createWorld(database.db, {
      key: `memory-integration-a-${suffix}`,
      name: "Memory Integration World A",
      systemType: "test",
    });
    const worldB = await createWorld(database.db, {
      key: `memory-integration-b-${suffix}`,
      name: "Memory Integration World B",
      systemType: "test",
    });
    worldIds.push(worldA.id, worldB.id);

    const npcA = await createNpc(database.db, worldA.id, peloNpcFixture);
    const npcA2 = await createNpc(database.db, worldA.id, {
      ...peloNpcFixture,
      canonicalName: `Pel\`o colleague ${suffix}`,
      baselineProfile: {
        ...peloNpcFixture.baselineProfile,
        identity: {
          ...peloNpcFixture.baselineProfile.identity,
          name: `Pel\`o colleague ${suffix}`,
        },
      },
    });
    const npcB = await createNpc(database.db, worldB.id, {
      ...peloNpcFixture,
      canonicalName: `Pel\`o counterpart ${suffix}`,
      baselineProfile: {
        ...peloNpcFixture.baselineProfile,
        identity: {
          ...peloNpcFixture.baselineProfile.identity,
          name: `Pel\`o counterpart ${suffix}`,
        },
      },
    });
    npcIds.push(npcA.entityId, npcA2.entityId, npcB.entityId);
    entityIds.push(npcA.entityId, npcA2.entityId, npcB.entityId);

    const sourceEntityA = await createEntity(database.db, worldA.id, {
      entityType: "organization",
      canonicalName: `Drahl Office ${suffix}`,
    });
    const sourceEntityB = await createEntity(database.db, worldB.id, {
      entityType: "organization",
      canonicalName: `Other World Office ${suffix}`,
    });
    entityIds.push(sourceEntityA.id, sourceEntityB.id);

    const firstMemory = await createMemory(
      database.db,
      worldA.id,
      npcA.entityId,
      peloMemoryFixtures[0]!,
    );
    expect(firstMemory).toMatchObject({
      summary: peloMemoryFixtures[0]!.summary,
      status: "active",
    });
    memoryIds.push(firstMemory!.id);
    await expect(
      getMemory(database.db, worldA.id, npcA.entityId, firstMemory!.id),
    ).resolves.toMatchObject({ id: firstMemory!.id });
    await expect(
      getMemory(database.db, worldB.id, npcA.entityId, firstMemory!.id),
    ).resolves.toBeNull();
    await expect(
      getMemory(database.db, worldA.id, npcA2.entityId, firstMemory!.id),
    ).resolves.toBeNull();

    const source = await addMemorySource(
      database.db,
      worldA.id,
      npcA.entityId,
      firstMemory!.id,
      {
        sourceType: "official",
        sourceEntityId: sourceEntityA.id,
        provenanceNote: "Personnel record annotation.",
      },
    );
    expect(source).toMatchObject({ sourceEntityId: sourceEntityA.id });
    await expect(
      listMemorySources(database.db, worldA.id, npcA.entityId, firstMemory!.id),
    ).resolves.toHaveLength(1);
    await expect(
      addMemorySource(database.db, worldA.id, npcA.entityId, firstMemory!.id, {
        sourceType: "official",
        sourceEntityId: sourceEntityB.id,
      }),
    ).rejects.toThrow("Source entity was not found in the memory's world.");

    const secondMemory = await createMemory(
      database.db,
      worldA.id,
      npcA.entityId,
      peloMemoryFixtures[1]!,
    );
    const otherNpcMemory = await createMemory(
      database.db,
      worldA.id,
      npcA2.entityId,
      peloMemoryFixtures[1]!,
    );
    const otherWorldMemory = await createMemory(
      database.db,
      worldB.id,
      npcB.entityId,
      peloMemoryFixtures[1]!,
    );
    memoryIds.push(secondMemory!.id, otherNpcMemory!.id, otherWorldMemory!.id);

    const relation = await addMemoryRelation(
      database.db,
      worldA.id,
      npcA.entityId,
      {
        parentMemoryId: firstMemory!.id,
        childMemoryId: secondMemory!.id,
        relationType: "related_to",
      },
    );
    expect(relation).toMatchObject({ relationType: "related_to" });
    await expect(
      listMemoryRelations(
        database.db,
        worldA.id,
        npcA.entityId,
        firstMemory!.id,
      ),
    ).resolves.toHaveLength(1);
    await expect(
      addMemoryRelation(database.db, worldA.id, npcA.entityId, {
        parentMemoryId: firstMemory!.id,
        childMemoryId: otherNpcMemory!.id,
        relationType: "related_to",
      }),
    ).resolves.toBeNull();
    await expect(
      addMemoryRelation(database.db, worldA.id, npcA.entityId, {
        parentMemoryId: firstMemory!.id,
        childMemoryId: otherWorldMemory!.id,
        relationType: "related_to",
      }),
    ).resolves.toBeNull();
    await expect(
      addMemoryRelation(database.db, worldA.id, npcA.entityId, {
        parentMemoryId: firstMemory!.id,
        childMemoryId: firstMemory!.id,
        relationType: "related_to",
      }),
    ).rejects.toThrow("A memory cannot have a relation to itself.");
    await expect(
      addMemoryRelation(database.db, worldA.id, npcA.entityId, {
        parentMemoryId: firstMemory!.id,
        childMemoryId: secondMemory!.id,
        relationType: "related_to",
      }),
    ).rejects.toThrow();

    await expect(
      updateMemoryStatus(
        database.db,
        worldA.id,
        npcA.entityId,
        firstMemory!.id,
        {
          status: "consolidated",
        },
      ),
    ).resolves.toMatchObject({ status: "consolidated" });
    await expect(
      updateMemoryStatus(
        database.db,
        worldA.id,
        npcA.entityId,
        secondMemory!.id,
        {
          status: "archived",
        },
      ),
    ).resolves.toMatchObject({ status: "archived" });
    await expect(
      getMemory(database.db, worldA.id, npcA.entityId, firstMemory!.id),
    ).resolves.toMatchObject({ summary: peloMemoryFixtures[0]!.summary });

    await expect(
      listMemories(database.db, worldA.id, npcA.entityId, {
        status: "consolidated",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: firstMemory!.id })]);
    await expect(
      listMemories(database.db, worldA.id, npcA.entityId, {
        memoryType: "episodic",
        retentionClass: "normal",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: secondMemory!.id })]);
  });

  it("persists subjective NPC knowledge with scoped sources and conflicts", async () => {
    const suffix = randomUUID();
    const worldA = await createWorld(database.db, {
      key: `knowledge-integration-a-${suffix}`,
      name: "Knowledge Integration World A",
      systemType: "test",
    });
    const worldB = await createWorld(database.db, {
      key: `knowledge-integration-b-${suffix}`,
      name: "Knowledge Integration World B",
      systemType: "test",
    });
    worldIds.push(worldA.id, worldB.id);

    const npcA = await createNpc(database.db, worldA.id, peloNpcFixture);
    const npcA2 = await createNpc(database.db, worldA.id, {
      ...peloNpcFixture,
      canonicalName: `Knowledge colleague ${suffix}`,
      baselineProfile: {
        ...peloNpcFixture.baselineProfile,
        identity: {
          ...peloNpcFixture.baselineProfile.identity,
          name: `Knowledge colleague ${suffix}`,
        },
      },
    });
    const npcB = await createNpc(database.db, worldB.id, {
      ...peloNpcFixture,
      canonicalName: `Knowledge counterpart ${suffix}`,
      baselineProfile: {
        ...peloNpcFixture.baselineProfile,
        identity: {
          ...peloNpcFixture.baselineProfile.identity,
          name: `Knowledge counterpart ${suffix}`,
        },
      },
    });
    npcIds.push(npcA.entityId, npcA2.entityId, npcB.entityId);
    entityIds.push(npcA.entityId, npcA2.entityId, npcB.entityId);

    const subjectA = await createEntity(database.db, worldA.id, {
      entityType: "ship",
      canonicalName: `Cargo Ship ${suffix}`,
    });
    const objectA = await createEntity(database.db, worldA.id, {
      entityType: "organization",
      canonicalName: `Dock Office ${suffix}`,
    });
    const entityB = await createEntity(database.db, worldB.id, {
      entityType: "organization",
      canonicalName: `Other World Office ${suffix}`,
    });
    entityIds.push(subjectA.id, objectA.id, entityB.id);

    const firstKnowledge = await createKnowledge(
      database.db,
      worldA.id,
      npcA.entityId,
      {
        ...peloKnowledgeFixtures[0]!,
        subjectEntityId: subjectA.id,
        predicate: "manifest_crate_count",
        objectEntityId: objectA.id,
        objectValue: 10,
      },
    );
    expect(firstKnowledge).toMatchObject({
      claimText: peloKnowledgeFixtures[0]!.claimText,
      subjectEntityId: subjectA.id,
      objectEntityId: objectA.id,
      objectValue: 10,
    });
    knowledgeIds.push(firstKnowledge!.id);
    await expect(
      getKnowledge(database.db, worldA.id, npcA.entityId, firstKnowledge!.id),
    ).resolves.toMatchObject({ id: firstKnowledge!.id });
    await expect(
      getKnowledge(database.db, worldB.id, npcA.entityId, firstKnowledge!.id),
    ).resolves.toBeNull();
    await expect(
      getKnowledge(database.db, worldA.id, npcA2.entityId, firstKnowledge!.id),
    ).resolves.toBeNull();
    await expect(
      createKnowledge(database.db, worldA.id, npcA.entityId, {
        ...peloKnowledgeFixtures[0]!,
        subjectEntityId: entityB.id,
      }),
    ).rejects.toThrow(
      "Referenced entity was not found in the knowledge's world.",
    );
    await expect(
      createKnowledge(database.db, worldA.id, npcA.entityId, {
        ...peloKnowledgeFixtures[0]!,
        objectEntityId: entityB.id,
      }),
    ).rejects.toThrow(
      "Referenced entity was not found in the knowledge's world.",
    );

    const memoryA = await createMemory(
      database.db,
      worldA.id,
      npcA.entityId,
      peloMemoryFixtures[0]!,
    );
    const memoryA2 = await createMemory(
      database.db,
      worldA.id,
      npcA2.entityId,
      peloMemoryFixtures[0]!,
    );
    memoryIds.push(memoryA!.id, memoryA2!.id);
    await expect(
      addKnowledgeSource(
        database.db,
        worldA.id,
        npcA.entityId,
        firstKnowledge!.id,
        {
          sourceType: "official",
          sourceEntityId: objectA.id,
        },
      ),
    ).resolves.toMatchObject({ sourceEntityId: objectA.id });
    await expect(
      addKnowledgeSource(
        database.db,
        worldA.id,
        npcA.entityId,
        firstKnowledge!.id,
        {
          sourceType: "official",
          sourceEntityId: entityB.id,
        },
      ),
    ).rejects.toThrow(
      "Referenced entity was not found in the knowledge's world.",
    );
    await expect(
      addKnowledgeSource(
        database.db,
        worldA.id,
        npcA.entityId,
        firstKnowledge!.id,
        {
          sourceType: "memory",
          sourceMemoryId: memoryA!.id,
        },
      ),
    ).resolves.toMatchObject({ sourceMemoryId: memoryA!.id });
    await expect(
      addKnowledgeSource(
        database.db,
        worldA.id,
        npcA.entityId,
        firstKnowledge!.id,
        {
          sourceType: "memory",
          sourceMemoryId: memoryA2!.id,
        },
      ),
    ).rejects.toThrow("Source memory was not found for the knowledge's NPC.");

    const secondKnowledge = await createKnowledge(
      database.db,
      worldA.id,
      npcA.entityId,
      peloKnowledgeFixtures[1]!,
    );
    const otherNpcKnowledge = await createKnowledge(
      database.db,
      worldA.id,
      npcA2.entityId,
      peloKnowledgeFixtures[0]!,
    );
    const otherWorldKnowledge = await createKnowledge(
      database.db,
      worldB.id,
      npcB.entityId,
      peloKnowledgeFixtures[0]!,
    );
    knowledgeIds.push(
      secondKnowledge!.id,
      otherNpcKnowledge!.id,
      otherWorldKnowledge!.id,
    );
    await expect(
      addKnowledgeSource(
        database.db,
        worldA.id,
        npcA.entityId,
        secondKnowledge!.id,
        {
          sourceType: "inferred",
          sourceKnowledgeId: firstKnowledge!.id,
          chainDepth: 1,
        },
      ),
    ).resolves.toMatchObject({ sourceKnowledgeId: firstKnowledge!.id });
    await expect(
      addKnowledgeSource(
        database.db,
        worldA.id,
        npcA.entityId,
        secondKnowledge!.id,
        {
          sourceType: "heard",
          sourceKnowledgeId: otherNpcKnowledge!.id,
          chainDepth: 1,
        },
      ),
    ).resolves.toMatchObject({ sourceKnowledgeId: otherNpcKnowledge!.id });
    await expect(
      addKnowledgeSource(
        database.db,
        worldA.id,
        npcA.entityId,
        secondKnowledge!.id,
        {
          sourceType: "heard",
          sourceKnowledgeId: otherWorldKnowledge!.id,
        },
      ),
    ).rejects.toThrow(
      "Source knowledge was not found in the knowledge's world.",
    );
    await expect(
      listKnowledgeSources(
        database.db,
        worldA.id,
        npcA.entityId,
        secondKnowledge!.id,
      ),
    ).resolves.toHaveLength(2);

    const conflict = await createKnowledgeConflict(
      database.db,
      worldA.id,
      npcA.entityId,
      firstKnowledge!.id,
      secondKnowledge!.id,
    );
    expect(conflict).toMatchObject({ status: "unresolved" });
    await expect(
      createKnowledgeConflict(
        database.db,
        worldA.id,
        npcA.entityId,
        secondKnowledge!.id,
        firstKnowledge!.id,
      ),
    ).rejects.toThrow();
    await expect(
      listKnowledgeConflicts(database.db, worldA.id, npcA.entityId),
    ).resolves.toEqual([expect.objectContaining({ id: conflict!.id })]);

    await expect(
      updateKnowledgeStatus(
        database.db,
        worldA.id,
        npcA.entityId,
        firstKnowledge!.id,
        {
          status: "disputed",
        },
      ),
    ).resolves.toMatchObject({ status: "disputed" });
    await expect(
      updateKnowledgeConfidence(
        database.db,
        worldA.id,
        npcA.entityId,
        firstKnowledge!.id,
        {
          confidence: 0.7,
        },
      ),
    ).resolves.toMatchObject({ confidence: 0.7 });
    await expect(
      getKnowledge(database.db, worldA.id, npcA.entityId, firstKnowledge!.id),
    ).resolves.toMatchObject({
      claimText: peloKnowledgeFixtures[0]!.claimText,
    });
    await expect(
      listKnowledge(database.db, worldA.id, npcA.entityId, {
        status: "disputed",
        subjectEntityId: subjectA.id,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: firstKnowledge!.id })]);
    await expect(
      listKnowledge(database.db, worldA.id, npcA.entityId, {
        classification: "reported_claim",
        secrecy: "public",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: secondKnowledge!.id })]);
  });

  it("persists directional relationship state and atomic event history", async () => {
    const suffix = randomUUID();
    const worldA = await createWorld(database.db, {
      key: `relationship-integration-a-${suffix}`,
      name: "Relationship Integration World A",
      systemType: "test",
    });
    const worldB = await createWorld(database.db, {
      key: `relationship-integration-b-${suffix}`,
      name: "Relationship Integration World B",
      systemType: "test",
    });
    worldIds.push(worldA.id, worldB.id);

    const pelo = await createNpc(database.db, worldA.id, peloNpcFixture);
    const severian = await createNpc(database.db, worldA.id, {
      ...peloNpcFixture,
      canonicalName: `Severian Drahl ${suffix}`,
      baselineProfile: {
        ...peloNpcFixture.baselineProfile,
        identity: {
          ...peloNpcFixture.baselineProfile.identity,
          name: `Severian Drahl ${suffix}`,
          role: "Imperial official",
        },
      },
    });
    const otherWorldNpc = await createNpc(database.db, worldB.id, {
      ...peloNpcFixture,
      canonicalName: `Other world official ${suffix}`,
      baselineProfile: {
        ...peloNpcFixture.baselineProfile,
        identity: {
          ...peloNpcFixture.baselineProfile.identity,
          name: `Other world official ${suffix}`,
        },
      },
    });
    npcIds.push(pelo.entityId, severian.entityId, otherWorldNpc.entityId);
    entityIds.push(pelo.entityId, severian.entityId, otherWorldNpc.entityId);

    const memoryPelo = await createMemory(
      database.db,
      worldA.id,
      pelo.entityId,
      peloMemoryFixtures[0]!,
    );
    const memorySeverian = await createMemory(
      database.db,
      worldA.id,
      severian.entityId,
      peloMemoryFixtures[0]!,
    );
    const knowledgePelo = await createKnowledge(
      database.db,
      worldA.id,
      pelo.entityId,
      peloKnowledgeFixtures[0]!,
    );
    const knowledgeSeverian = await createKnowledge(
      database.db,
      worldA.id,
      severian.entityId,
      peloKnowledgeFixtures[0]!,
    );
    memoryIds.push(memoryPelo!.id, memorySeverian!.id);
    knowledgeIds.push(knowledgePelo!.id, knowledgeSeverian!.id);

    const peloToSeverian = await createRelationship(
      database.db,
      worldA.id,
      pelo.entityId,
      severian.entityId,
      peloToSeverianRelationshipFixture,
    );
    relationshipIds.push(peloToSeverian.id);
    await expect(
      getRelationship(database.db, worldA.id, pelo.entityId, severian.entityId),
    ).resolves.toMatchObject({ id: peloToSeverian.id, version: 1 });
    await expect(
      getRelationship(database.db, worldA.id, severian.entityId, pelo.entityId),
    ).resolves.toBeNull();

    const severianToPelo = await createRelationship(
      database.db,
      worldA.id,
      severian.entityId,
      pelo.entityId,
      { trust: 64, respect: 72, fear: 10 },
    );
    relationshipIds.push(severianToPelo.id);
    expect(severianToPelo.trust).toBe(64);
    await expect(
      getRelationship(database.db, worldB.id, pelo.entityId, severian.entityId),
    ).resolves.toBeNull();
    await expect(
      createRelationship(
        database.db,
        worldA.id,
        pelo.entityId,
        severian.entityId,
      ),
    ).rejects.toThrow();

    await expect(
      applyRelationshipEvent(
        database.db,
        worldA.id,
        pelo.entityId,
        severian.entityId,
        {
          ...peloSeverianTaskEventFixture,
          sourceMemoryId: memorySeverian!.id,
        },
      ),
    ).rejects.toThrow("Source memory is not available for this relationship.");
    await expect(
      applyRelationshipEvent(
        database.db,
        worldA.id,
        pelo.entityId,
        severian.entityId,
        {
          ...peloSeverianTaskEventFixture,
          sourceKnowledgeId: knowledgeSeverian!.id,
        },
      ),
    ).rejects.toThrow(
      "Source knowledge is not available for this relationship.",
    );

    const applied = await applyRelationshipEvent(
      database.db,
      worldA.id,
      pelo.entityId,
      severian.entityId,
      {
        ...peloSeverianTaskEventFixture,
        expectedVersion: 1,
        sourceMemoryId: memoryPelo!.id,
        sourceKnowledgeId: knowledgePelo!.id,
      },
    );
    expect(applied).toMatchObject({
      relationship: { trust: 85, respect: 92, obligation: 70, version: 2 },
      event: {
        delta: peloSeverianTaskEventFixture.delta,
        reasonSummary: peloSeverianTaskEventFixture.reasonSummary,
      },
    });
    await expect(
      applyRelationshipEvent(
        database.db,
        worldA.id,
        pelo.entityId,
        severian.entityId,
        { ...peloSeverianTaskEventFixture, expectedVersion: 1 },
      ),
    ).rejects.toBeInstanceOf(RelationshipVersionConflictError);
    await expect(
      getRelationship(database.db, worldA.id, pelo.entityId, severian.entityId),
    ).resolves.toMatchObject({ trust: 85, version: 2 });
    await expect(
      listRelationshipEvents(
        database.db,
        worldA.id,
        pelo.entityId,
        severian.entityId,
      ),
    ).resolves.toHaveLength(1);
    await expect(
      applyRelationshipEvent(
        database.db,
        worldA.id,
        pelo.entityId,
        severian.entityId,
        {
          eventType: "gift",
          delta: { trust: 100 },
          reasonSummary: "An invalidly large state transition.",
        },
      ),
    ).rejects.toThrow("Relationship trust would be outside the 0..100 range.");
    await expect(
      listRelationshipEvents(
        database.db,
        worldA.id,
        pelo.entityId,
        severian.entityId,
      ),
    ).resolves.toHaveLength(1);

    await expect(
      updateRelationshipIntent(
        database.db,
        worldA.id,
        pelo.entityId,
        severian.entityId,
        "protective",
      ),
    ).resolves.toMatchObject({ intent: "protective", version: 3 });
    const secondEvent = await applyRelationshipEvent(
      database.db,
      worldA.id,
      pelo.entityId,
      severian.entityId,
      {
        eventType: "shared_experience",
        delta: { familiarity: 1 },
        reasonSummary: "They completed the assigned work together.",
        expectedVersion: 3,
      },
    );
    const events = await listRelationshipEvents(
      database.db,
      worldA.id,
      pelo.entityId,
      severian.entityId,
    );
    expect(events.map((event) => event.id)).toEqual([
      applied!.event.id,
      secondEvent!.event.id,
    ]);
    await expect(
      listRelationshipsFrom(database.db, worldA.id, pelo.entityId),
    ).resolves.toEqual([expect.objectContaining({ id: peloToSeverian.id })]);
    await expect(
      listRelationshipsTo(database.db, worldA.id, pelo.entityId),
    ).resolves.toEqual([expect.objectContaining({ id: severianToPelo.id })]);
  });
});
