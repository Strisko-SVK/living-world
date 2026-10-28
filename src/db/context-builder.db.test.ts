import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "./client.js";
import {
  createContextReader,
  createNpcContextBuilder,
  CONTEXT_CANDIDATE_CAP,
} from "../context/context.repository.js";
import {
  createContextBuilder,
  ContextUnavailableError,
  estimateContextBytes,
} from "../context/context-builder.js";
import { createWorld } from "../domains/world/world.repository.js";
import { createEntity } from "../domains/entity/entity.repository.js";
import { createNpc, getNpcWithState } from "../domains/npc/npc.repository.js";
import { peloNpcFixture } from "../domains/npc/npc.test-fixture.js";
import {
  createInteraction,
  createInteractionContext,
  getInteraction,
} from "../domains/interaction/interaction.repository.js";
import {
  addKnowledgeSource,
  createKnowledge,
  createKnowledgeConflict,
} from "../domains/knowledge/knowledge.repository.js";
import {
  addMemorySource,
  createMemory,
} from "../domains/memory/memory.repository.js";
import { createRelationship } from "../domains/relationship/relationship.repository.js";

const database = createDatabaseClient();
const worlds: string[] = [];
let world: string,
  foreignWorld: string,
  npc: string,
  otherNpc: string,
  speaker: string,
  foreignNpc: string;
let scene: string,
  parallelScene: string,
  target: string,
  previous: string,
  unrelated: string,
  ownClaim: string,
  contraryClaim: string,
  ownMemory: string;
const build = createNpcContextBuilder(database.db);

beforeAll(async () => {
  const a = await createWorld(database.db, {
    key: "context-a-" + randomUUID(),
    name: "Context A",
    systemType: "test",
  });
  worlds.push(a.id);
  world = a.id;
  const b = await createWorld(database.db, {
    key: "context-b-" + randomUUID(),
    name: "Context B",
    systemType: "test",
  });
  worlds.push(b.id);
  foreignWorld = b.id;
  npc = (await createNpc(database.db, world, peloNpcFixture)).entityId;
  otherNpc = (
    await createNpc(database.db, world, {
      ...peloNpcFixture,
      canonicalName: "Other NPC",
    })
  ).entityId;
  foreignNpc = (await createNpc(database.db, foreignWorld, peloNpcFixture))
    .entityId;
  speaker = (
    await createEntity(database.db, world, {
      entityType: "player_character",
      canonicalName: "Garak",
    })
  ).id;
  scene = (
    await createInteractionContext(database.db, world, {
      contextType: "scene",
      externalProvider: "discord",
      externalGuildId: "synthetic-guild",
      externalChannelId: "synthetic-channel",
      metadata: { physicalPresence: true, gameTime: "must not infer" },
    })
  ).id;
  parallelScene = (
    await createInteractionContext(database.db, world, { contextType: "scene" })
  ).id;
  const base = {
    interactionType: "social" as const,
    communicationMode: "unknown" as const,
    requestText: "Check docking manifest",
    speakerEntityId: speaker,
  };
  previous = (await createInteraction(database.db, world, npc, {
    ...base,
    contextId: scene,
  }))!.id;
  unrelated = (await createInteraction(database.db, world, npc, {
    ...base,
    requestText: "A secret parallel scene",
    contextId: parallelScene,
  }))!.id;
  await createInteraction(database.db, world, otherNpc, {
    ...base,
    requestText: "Another NPC's private request",
    contextId: scene,
  });
  target = (await createInteraction(database.db, world, npc, {
    ...base,
    contextId: scene,
  }))!.id;
  ownClaim = (await createKnowledge(database.db, world, npc, {
    subjectEntityId: speaker,
    claimText: "The docking manifest is correct",
    classification: "reported_claim",
    confidence: 0.3,
    secrecy: "private",
  }))!.id;
  contraryClaim = (await createKnowledge(database.db, world, npc, {
    subjectEntityId: speaker,
    claimText: "The docking manifest is incorrect",
    classification: "rumor",
    confidence: 0.8,
    secrecy: "secret",
    status: "disputed",
  }))!.id;
  await createKnowledgeConflict(
    database.db,
    world,
    npc,
    ownClaim,
    contraryClaim,
  );
  const hidden = (await createKnowledge(database.db, world, otherNpc, {
    claimText: "Exclusive archive knowledge",
    classification: "fact",
    confidence: 1,
    secrecy: "secret",
  }))!;
  await addKnowledgeSource(database.db, world, npc, ownClaim, {
    sourceType: "archive",
    externalRef: "own-read-archive",
    provenanceNote: "The NPC has read this claim",
  });
  // Existing provenance may reference another NPC's claim in the same world.
  // The builder must not return or dereference this unavailable source.
  await addKnowledgeSource(database.db, world, npc, ownClaim, {
    sourceType: "heard",
    sourceKnowledgeId: hidden.id,
    provenanceNote: "Unavailable source",
  });
  await createKnowledge(database.db, foreignWorld, foreignNpc, {
    claimText: "Foreign manifest knowledge",
    classification: "fact",
    confidence: 1,
    secrecy: "public",
  });
  await createKnowledge(database.db, world, npc, {
    claimText: "Invalid manifest claim",
    classification: "fact",
    confidence: 1,
    secrecy: "public",
    status: "invalidated",
  });
  ownMemory = (await createMemory(database.db, world, npc, {
    memoryType: "episodic",
    summary: "I checked the docking manifest",
    importance: 70,
    detailLevel: "high",
    retentionClass: "important",
  }))!.id;
  await addMemorySource(database.db, world, npc, ownMemory, {
    sourceType: "interaction",
    sourceInteractionId: previous,
    sourceEntityId: speaker,
    provenanceNote: "Observed in the scene",
  });
  await createMemory(database.db, world, otherNpc, {
    memoryType: "episodic",
    summary: "Another NPC's secret manifest memory",
    importance: 100,
    detailLevel: "high",
    retentionClass: "permanent",
  });
  await createMemory(database.db, world, npc, {
    memoryType: "episodic",
    summary: "Archived manifest details",
    importance: 100,
    detailLevel: "high",
    retentionClass: "permanent",
    status: "archived",
  });
  await createRelationship(database.db, world, npc, speaker, {
    trust: 72,
    intent: "genuine",
  });
  await createRelationship(database.db, world, speaker, npc, {
    trust: 3,
    intent: "manipulative",
  });
});

afterAll(async () => {
  try {
    for (const id of worlds) {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        for (const query of [
          "delete from knowledge_sources where knowledge_id in (select id from npc_knowledge where world_id = $1)",
          "delete from knowledge_conflicts where world_id = $1",
          "delete from npc_knowledge where world_id = $1",
          "delete from memory_sources where memory_id in (select id from npc_memories where world_id = $1)",
          "delete from npc_memories where world_id = $1",
          "delete from relationships where world_id = $1",
          "delete from interactions where world_id = $1",
          "delete from interaction_contexts where world_id = $1",
          "delete from npc_capabilities where npc_id in (select id from entities where world_id = $1)",
          "delete from npc_game_profiles where npc_id in (select id from entities where world_id = $1)",
          "delete from npc_state where npc_id in (select id from entities where world_id = $1)",
          "delete from npcs where entity_id in (select id from entities where world_id = $1)",
          "delete from entities where world_id = $1",
          "delete from worlds where id = $1",
        ])
          await client.query(query, [id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await database.close();
  }
});

describe("Context Builder repository composition", () => {
  it("keeps batched sources scoped even when the reader is reused with different arguments", async () => {
    const reader = createContextReader(database.db);
    await reader.knowledge(world, npc);
    expect(
      await reader.knowledgeSources(world, npc, ownClaim),
    ).not.toHaveLength(0);
    expect(await reader.knowledgeSources(foreignWorld, npc, ownClaim)).toEqual(
      [],
    );
    expect(await reader.knowledgeSources(world, otherNpc, ownClaim)).toEqual(
      [],
    );
    await reader.memories(world, npc);
    expect(await reader.memorySources(world, npc, ownMemory)).not.toHaveLength(
      0,
    );
    expect(await reader.memorySources(foreignWorld, npc, ownMemory)).toEqual(
      [],
    );
    expect(await reader.memorySources(world, otherNpc, ownMemory)).toEqual([]);
  });
  it("retrieves complete cyclic conflict groups including lexically unrelated partners", async () => {
    const rollback = new Error("rollback");
    await expect(
      database.db.transaction(async (tx) => {
        const partner = (await createKnowledge(tx, world, npc, {
          claimText: "Unrelated astronomy",
          classification: "rumor",
          confidence: 0.5,
          secrecy: "private",
        }))!;
        await createKnowledgeConflict(
          tx,
          world,
          npc,
          partner.id,
          contraryClaim,
        );
        await createKnowledgeConflict(tx, world, npc, partner.id, ownClaim);
        const bundle = await createContextBuilder(createContextReader(tx))({
          worldId: world,
          npcId: npc,
          interactionId: target,
        });
        expect(
          new Set(bundle.knowledge[0].claims.map((claim) => claim.record.id)),
        ).toEqual(new Set([ownClaim, contraryClaim, partner.id]));
        expect(bundle.knowledge[0].conflicts).toHaveLength(3);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("omits an entire component when a persisted partner becomes inaccessible", async () => {
    const rollback = new Error("rollback");
    await expect(
      database.db.transaction(async (tx) => {
        await tx.execute(
          sql`update npc_knowledge set status='invalidated' where id=${contraryClaim}`,
        );
        const bundle = await createContextBuilder(createContextReader(tx))({
          worldId: world,
          npcId: npc,
          interactionId: target,
        });
        expect(bundle.knowledge).toEqual([]);
        expect(JSON.stringify(bundle)).not.toContain(
          "The docking manifest is correct",
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("fails closed when a conflict closure exceeds the database candidate cap", async () => {
    const rollback = new Error("rollback");
    await expect(
      database.db.transaction(async (tx) => {
        await tx.execute(sql`with added as (
        insert into npc_knowledge(id,world_id,npc_id,claim_text,classification,confidence,secrecy)
        select gen_random_uuid(),${world},${npc},'unrelated astronomy','rumor',0.5,'private' from generate_series(1,${CONTEXT_CANDIDATE_CAP}) returning id
      ) insert into knowledge_conflicts(id,world_id,npc_id,claim_a_id,claim_b_id)
        select gen_random_uuid(),${world},${npc},least(id,${ownClaim}::uuid),greatest(id,${ownClaim}::uuid) from added`);
        await expect(
          createContextBuilder(createContextReader(tx))({
            worldId: world,
            npcId: npc,
            interactionId: target,
          }),
        ).rejects.toBeInstanceOf(ContextUnavailableError);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("bounds large source collections in SQL while preserving total and omitted counts", async () => {
    const rollback = new Error("rollback");
    await expect(
      database.db.transaction(async (tx) => {
        await tx.execute(
          sql`insert into knowledge_sources(id,knowledge_id,source_type) select gen_random_uuid(),${ownClaim},'heard' from generate_series(1,1000)`,
        );
        await tx.execute(
          sql`insert into memory_sources(id,memory_id,source_type) select gen_random_uuid(),${ownMemory},'heard' from generate_series(1,1000)`,
        );
        const bundle = await createContextBuilder(createContextReader(tx))({
          worldId: world,
          npcId: npc,
          interactionId: target,
          limits: { sourcesPerRecord: 2 },
        });
        const provenance = bundle.knowledge
          .flatMap((group) => group.claims)
          .find((claim) => claim.record.id === ownClaim)!.provenance;
        expect(provenance).toMatchObject({ total: 1002, omitted: 1000 });
        expect(provenance.sources).toHaveLength(2);
        expect(bundle.memories[0].provenance).toMatchObject({
          total: 1001,
          omitted: 999,
        });
        expect(bundle.memories[0].provenance.sources).toHaveLength(2);
        expect(bundle.retrieval.provenanceTruncated).toBe(true);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("retains scoped memory relevance even with zero provenance output", async () => {
    const rollback = new Error("rollback");
    await expect(
      database.db.transaction(async (tx) => {
        await tx.execute(
          sql`update npc_memories set summary='Unrelated astronomy' where id=${ownMemory}`,
        );
        const reader = createContextReader(tx);
        const bundle = await createContextBuilder(reader)({
          worldId: world,
          npcId: npc,
          interactionId: target,
          limits: { sourcesPerRecord: 0 },
        });
        expect(bundle.memories[0]).toMatchObject({
          record: { id: ownMemory },
          reasons: ["scene_interaction_provenance", "participant_provenance"],
          provenance: { sources: [], total: 1, omitted: 1 },
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("assembles a scoped scene bundle from actual persisted records", async () => {
    const bundle = await build({
      worldId: world,
      npcId: npc,
      interactionId: target,
    });
    expect(bundle.npc.npc.entityId).toBe(npc);
    expect(bundle.gameProfile?.npcId).toBe(npc);
    expect(bundle.current.context?.id).toBe(scene);
    expect(bundle.history.map((item) => item.record.id)).toEqual([previous]);
    expect(bundle.history.some((item) => item.record.id === unrelated)).toBe(
      false,
    );
    expect(
      new Set(bundle.knowledge[0].claims.map((item) => item.record.id)),
    ).toEqual(new Set([ownClaim, contraryClaim]));
    expect(bundle.knowledge[0].conflicts).toHaveLength(1);
    expect(bundle.memories).toMatchObject([
      {
        record: { id: ownMemory },
        provenance: { sources: [{ sourceInteractionId: previous }] },
      },
    ]);
    expect(bundle.relationships).toMatchObject([
      { record: { sourceEntityId: npc, targetEntityId: speaker, trust: 72 } },
    ]);
    const serialized = JSON.stringify(bundle);
    for (const unavailable of [
      "Exclusive archive knowledge",
      "Foreign manifest knowledge",
      "Invalid manifest claim",
      "Another NPC's secret manifest memory",
      "Archived manifest details",
      "Another NPC's private request",
      "A secret parallel scene",
      "Unavailable source",
    ])
      expect(serialized).not.toContain(unavailable);
    expect(
      bundle.knowledge
        .find((group) =>
          group.claims.some((item) => item.record.id === ownClaim),
        )
        ?.claims.find((item) => item.record.id === ownClaim)?.provenance
        .unavailable,
    ).toBe(1);
  });
  it("rejects foreign-world and wrong-NPC interaction resolution", async () => {
    await expect(
      build({ worldId: foreignWorld, npcId: npc, interactionId: target }),
    ).rejects.toBeInstanceOf(ContextUnavailableError);
    await expect(
      build({ worldId: world, npcId: otherNpc, interactionId: target }),
    ).rejects.toBeInstanceOf(ContextUnavailableError);
  });
  it("is deterministic and respects total and per-category budgets without splitting contradictions", async () => {
    const request = {
      worldId: world,
      npcId: npc,
      interactionId: target,
      limits: {
        knowledge: 1,
        memories: 0,
        history: 0,
        relationships: 0,
        capabilities: 0,
      },
    };
    const bundle = await build(request);
    expect(await build(request)).toEqual(bundle);
    expect(bundle.knowledge).toHaveLength(0);
    expect(bundle.retrieval.categories.knowledge.omittedByLimit).toBe(2);
    expect(bundle.budget.estimatedBytes).toBe(estimateContextBytes(bundle));
    expect(bundle.budget.estimatedBytes).toBeLessThanOrEqual(
      bundle.budget.maxBytes,
    );
  });
  it("leaves interaction lifecycle, NPC state, domain records and game chronology unchanged", async () => {
    const before = await getNpcWithState(database.db, world, npc);
    const interaction = await getInteraction(database.db, world, npc, target);
    const snapshot = async () =>
      Promise.all(
        [
          "npc_knowledge",
          "knowledge_conflicts",
          "npc_memories",
          "relationships",
          "tasks",
        ].map(
          async (table) =>
            (
              await database.pool.query(
                `select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) as records from ${table} t where world_id = $1`,
                [world],
              )
            ).rows,
        ),
      );
    const records = await snapshot();
    const bundle = await build({
      worldId: world,
      npcId: npc,
      interactionId: target,
    });
    expect(await snapshot()).toEqual(records);
    expect(await getNpcWithState(database.db, world, npc)).toEqual(before);
    expect(await getInteraction(database.db, world, npc, target)).toEqual(
      interaction,
    );
    expect(bundle.current.interaction.status).toBe("received");
    expect(bundle.temporal.gameTime).toBeNull();
    expect(bundle.temporal.parallelScenes).toBe("not_sequenced");
    expect(bundle.presence.scenePresence).toBe("not_established");
    expect(bundle.presence.remoteReachability).toBe("unknown");
  });
});
