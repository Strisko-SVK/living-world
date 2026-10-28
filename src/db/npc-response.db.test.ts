import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "./client.js";
import { createWorld } from "../domains/world/world.repository.js";
import { createEntity } from "../domains/entity/entity.repository.js";
import { createNpc, getNpcWithState } from "../domains/npc/npc.repository.js";
import { peloNpcFixture } from "../domains/npc/npc.test-fixture.js";
import {
  createInteraction,
  createInteractionContext,
  getInteraction,
  recordInteractionResponse,
  failInteraction,
} from "../domains/interaction/interaction.repository.js";
import {
  createKnowledge,
  addKnowledgeSource,
} from "../domains/knowledge/knowledge.repository.js";
import { createNpcContextBuilder } from "../context/context.repository.js";
import { createResponseStore } from "../response/response.repository.js";
import { createNpcResponseOrchestrator } from "../response/orchestrator.js";
import { ProviderFailure } from "../llm/contracts.js";
import { createTextGenerator } from "../llm/generation.js";
import {
  enabledConfig,
  fakeBudget,
  fakeProvider,
} from "../llm/llm.test-fixture.js";
import type {
  ResponseDependencies,
  ResponseScope,
} from "../response/contracts.js";

const database = createDatabaseClient();
const store = createResponseStore(database.db);
const worlds: string[] = [];
let locationId: string;
let world: string,
  foreignWorld: string,
  npc: string,
  otherNpc: string,
  scene: string;
beforeAll(async () => {
  for (let n = 0; n < 2; n++)
    worlds.push(
      (
        await createWorld(database.db, {
          key: "response-test-" + randomUUID(),
          name: "Response test world",
          systemType: "test",
        })
      ).id,
    );
  [world, foreignWorld] = worlds;
  const location = await createEntity(database.db, world, {
    entityType: "location",
    canonicalName: "Response fixture location",
  });
  locationId = location.id;
  npc = (
    await createNpc(database.db, world, {
      ...peloNpcFixture,
      initialState: {
        ...peloNpcFixture.initialState,
        currentLocationId: location.id,
        locationCertainty: "certain",
      },
    })
  ).entityId;
  otherNpc = (
    await createNpc(database.db, world, {
      ...peloNpcFixture,
      canonicalName: "Unrelated NPC",
    })
  ).entityId;
  scene = (
    await createInteractionContext(database.db, world, {
      contextType: "scene",
      linkedLocationEntityId: location.id,
    })
  ).id;
  const known = (await createKnowledge(database.db, world, npc, {
    claimText: "The manifest may contain ten crates",
    classification: "reported_claim",
    confidence: 0.4,
    secrecy: "public",
  }))!;
  await addKnowledgeSource(database.db, world, npc, known.id, {
    sourceType: "witnessed",
    sourceEntityId: npc,
  });
});
afterAll(async () => {
  try {
    for (const id of worlds) {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        for (const query of [
          "delete from knowledge_sources where knowledge_id in (select id from npc_knowledge where world_id=$1)",
          "delete from npc_knowledge where world_id=$1",
          "delete from interactions where world_id=$1",
          "delete from interaction_contexts where world_id=$1",
          "delete from npc_capabilities where npc_id in (select id from entities where world_id=$1)",
          "delete from npc_game_profiles where npc_id in (select id from entities where world_id=$1)",
          "delete from npc_state where npc_id in (select id from entities where world_id=$1)",
          "delete from npcs where entity_id in (select id from entities where world_id=$1)",
          "delete from entities where world_id=$1",
          "delete from worlds where id=$1",
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
async function interaction() {
  // Each scenario owns its scene. Previously generated fixture speech must not
  // become unperceived history (and an excluded-text match) for another test.
  const context = await createInteractionContext(database.db, world, {
    contextType: "scene",
    linkedLocationEntityId: locationId,
  });
  return (await createInteraction(database.db, world, npc, {
    contextId: context.id,
    communicationMode: "local",
    interactionType: "social",
    requestText: "Check the manifest",
  }))!;
}
const scope = (id: string): ResponseScope => ({
  worldId: world,
  npcId: npc,
  interactionId: id,
});
const read = (s: ResponseScope) =>
  getInteraction(database.db, s.worldId, s.npcId, s.interactionId);
function pipeline(overrides: Partial<ResponseDependencies> = {}) {
  const provider = fakeProvider(),
    budget = fakeBudget();
  vi.mocked(provider.generate).mockResolvedValue({
    text: JSON.stringify({
      speech: "I believe it may contain ten crates, but I am uncertain.",
    }),
    completed: true,
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
  });
  const generate = createTextGenerator(enabledConfig(), provider, budget);
  return {
    provider,
    budget,
    run: createNpcResponseOrchestrator({
      read,
      build: createNpcContextBuilder(database.db),
      store,
      generate,
      ...overrides,
    }),
  };
}
describe("NPC response PostgreSQL lifecycle and concurrency", () => {
  it.each(["closed", "location", "uncertain", "inactive", "persona"])(
    "rejects stale context before claiming: %s",
    async (change) => {
      const row = await interaction();
      const build = createNpcContextBuilder(database.db);
      const p = pipeline({
        build: async (request) => {
          const bundle = await build(request);
          if (change === "closed")
            await database.pool.query(
              "update interaction_contexts set status='inactive' where id=$1",
              [row.contextId],
            );
          if (change === "location")
            await database.pool.query(
              "update npc_state set current_location_id=null where npc_id=$1",
              [npc],
            );
          if (change === "uncertain")
            await database.pool.query(
              "update npc_state set location_certainty='unknown' where npc_id=$1",
              [npc],
            );
          if (change === "inactive")
            await database.pool.query(
              "update npcs set lifecycle_state='dormant' where entity_id=$1",
              [npc],
            );
          if (change === "persona")
            bundle.npc.npc.canonicalName = "Stale persona";
          return bundle;
        },
      });
      try {
        expect(await p.run(world, npc, row.id)).toMatchObject({
          error: "ineligible",
        });
        expect(p.provider.countInput).not.toHaveBeenCalled();
        expect(p.provider.generate).not.toHaveBeenCalled();
        expect(p.budget.reserve).not.toHaveBeenCalled();
        expect((await read(scope(row.id)))?.status).toBe("received");
      } finally {
        await database.pool.query(
          "update npc_state set current_location_id=$1,location_certainty='certain' where npc_id=$2",
          [locationId, npc],
        );
        await database.pool.query(
          "update npcs set lifecycle_state='active' where entity_id=$1",
          [npc],
        );
      }
    },
  );
  it("blocks a scene closed after claim and before dispatch", async () => {
    const row = await interaction();
    const p = pipeline({
      store: {
        ...store,
        claim: async (...args) => {
          const claimed = await store.claim(...args);
          await database.pool.query(
            "update interaction_contexts set status='inactive' where id=$1",
            [row.contextId],
          );
          return claimed;
        },
      },
    });
    expect(await p.run(world, npc, row.id)).toMatchObject({
      error: "claim_lost",
    });
    expect(p.provider.countInput).not.toHaveBeenCalled();
    expect(p.budget.reserve).not.toHaveBeenCalled();
    expect(await read(scope(row.id))).toMatchObject({
      status: "failed",
      responseGenerationOutcome: "failed",
      responseDispatchedAt: null,
    });
  });
  it("blocks token preflight when conditions change after the dispatch marker", async () => {
    const row = await interaction();
    const p = pipeline({
      store: {
        ...store,
        dispatch: async (...args) => {
          const dispatched = await store.dispatch(...args);
          await database.pool.query(
            "update interaction_contexts set status='inactive' where id=$1",
            [row.contextId],
          );
          return dispatched;
        },
      },
    });
    expect(await p.run(world, npc, row.id)).toMatchObject({
      error: "generation_failed",
      providerError: "cancelled",
    });
    expect(p.provider.countInput).not.toHaveBeenCalled();
    expect(p.provider.generate).not.toHaveBeenCalled();
    expect(p.budget.reserve).not.toHaveBeenCalled();
  });
  it("blocks generation after a location change during token preflight and settles once", async () => {
    const row = await interaction(),
      p = pipeline();
    vi.mocked(p.provider.countInput).mockImplementation(async () => {
      await database.pool.query(
        "update npc_state set current_location_id=null where npc_id=$1",
        [npc],
      );
      return 10;
    });
    try {
      expect(await p.run(world, npc, row.id)).toMatchObject({
        error: "generation_failed",
        providerError: "cancelled",
      });
      expect(p.provider.generate).not.toHaveBeenCalled();
      expect(p.budget.reserve).toHaveBeenCalledTimes(1);
      expect(p.budget.settle).toHaveBeenCalledTimes(1);
      expect(p.budget.settle).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ charged: 0n, uncertain: false }),
      );
      expect((await read(scope(row.id)))?.responseText).toBeNull();
    } finally {
      await database.pool.query(
        "update npc_state set current_location_id=$1 where npc_id=$2",
        [locationId, npc],
      );
    }
  });
  it.each(["scene", "location", "persona", "relocated"])(
    "withholds an in-flight result after changed %s without holding locks or regenerating",
    async (change) => {
      const row = await interaction(),
        p = pipeline();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.mocked(p.provider.generate).mockImplementation(async () => {
        entered();
        await gate;
        return {
          text: JSON.stringify({ speech: "I cannot confirm this report." }),
          completed: true,
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        };
      });
      const pending = p.run(world, npc, row.id);
      try {
        await Promise.race([
          started,
          pending.then(() => {
            throw Error("No dispatch");
          }),
        ]);
        const client = await database.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL lock_timeout='1s'");
          if (change === "scene")
            await client.query(
              "update interaction_contexts set status='inactive' where id=$1",
              [row.contextId],
            );
          if (change === "location")
            await client.query(
              "update npc_state set current_location_id=null where npc_id=$1",
              [npc],
            );
          if (change === "relocated") {
            const moved = await createEntity(database.db, world, {
              entityType: "location",
              canonicalName: "Moved together",
            });
            await client.query(
              "update npc_state set current_location_id=$1 where npc_id=$2",
              [moved.id, npc],
            );
            await client.query(
              "update interaction_contexts set linked_location_entity_id=$1 where id=$2",
              [moved.id, row.contextId],
            );
          }
          if (change === "persona")
            await client.query(
              "update npc_state set emotional_state='{}'::jsonb where npc_id=$1",
              [npc],
            );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      } finally {
        release();
      }
      try {
        expect(await pending).toMatchObject({ error: "claim_lost" });
        expect(await read(scope(row.id))).toMatchObject({
          status: "failed",
          responseText: null,
          responseGenerationOutcome: "uncertain",
        });
        expect(await p.run(world, npc, row.id)).toMatchObject({
          error: "ineligible",
        });
        expect(p.provider.generate).toHaveBeenCalledTimes(1);
        expect(p.budget.reserve).toHaveBeenCalledTimes(1);
        expect(p.budget.settle).toHaveBeenCalledTimes(1);
      } finally {
        await database.pool.query(
          "update npc_state set current_location_id=$1,emotional_state=$2::jsonb where npc_id=$3",
          [
            locationId,
            JSON.stringify(peloNpcFixture.initialState?.emotionalState ?? {}),
            npc,
          ],
        );
      }
    },
  );
  it("waits for an authoritative scene writer and sees its committed revocation", async () => {
    const row = await interaction(),
      s = scope(row.id);
    const bundle = await createNpcContextBuilder(database.db)({
      ...s,
      limits: { history: 0 },
    });
    const client = await database.pool.connect();
    let claiming: ReturnType<typeof store.claim> | undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        "update interaction_contexts set status='inactive' where id=$1",
        [row.contextId],
      );
      const {
        rows: [writer],
      } = await client.query("select pg_backend_pid() as pid");
      claiming = store.claim(s, row, bundle);
      // Verify the claimant is actually waiting for this writer's row lock.
      await vi.waitFor(
        async () => {
          const { rows } = await database.pool.query(
            "select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))",
            [writer.pid],
          );
          expect(rows.length).toBeGreaterThan(0);
        },
        { timeout: 2000, interval: 10 },
      );
      await client.query("COMMIT");
      expect(await claiming).toBeNull();
      expect((await read(s))?.responseClaimId).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await claiming;
    }
  });
  it("does not retry a provider attempt after scene revocation and settles the one reservation", async () => {
    const row = await interaction(),
      p = pipeline();
    vi.mocked(p.provider.generate).mockImplementationOnce(async () => {
      await database.pool.query(
        "update interaction_contexts set status='inactive' where id=$1",
        [row.contextId],
      );
      throw new ProviderFailure("rate_limit", true, 0, true);
    });
    expect(await p.run(world, npc, row.id)).toMatchObject({
      error: "generation_failed",
      providerError: "cancelled",
    });
    expect(p.provider.generate).toHaveBeenCalledTimes(1);
    expect(p.budget.reserve).toHaveBeenCalledTimes(1);
    expect(p.budget.settle).toHaveBeenCalledTimes(1);
    expect((await read(scope(row.id)))?.responseText).toBeNull();
  });
  it("never sends attributed public knowledge even when access changes during preflight", async () => {
    const row = await interaction(),
      p = pipeline();
    vi.mocked(p.provider.countInput).mockImplementation(async (request) => {
      expect(JSON.stringify(request)).not.toContain(
        "The manifest may contain ten crates",
      );
      await database.pool.query(
        "update npc_knowledge set secrecy='restricted' where world_id=$1 and npc_id=$2",
        [world, npc],
      );
      return 10;
    });
    try {
      expect((await p.run(world, npc, row.id)).ok).toBe(true);
      const request = vi.mocked(p.provider.generate).mock.calls[0][0];
      expect(JSON.stringify(request)).not.toContain(
        "The manifest may contain ten crates",
      );
      expect(
        JSON.parse(
          request.messages.find((message) => message.role === "user")!.content,
        ).untrustedContext.permittedKnowledge,
      ).toEqual([]);
      expect(p.provider.generate).toHaveBeenCalledTimes(1);
      expect(p.budget.reserve).toHaveBeenCalledTimes(1);
    } finally {
      await database.pool.query(
        "update npc_knowledge set secrecy='public' where world_id=$1 and npc_id=$2",
        [world, npc],
      );
    }
  });
  it("fences an in-flight worker after explicit stale reconciliation without another provider call", async () => {
    const row = await interaction(),
      s = scope(row.id),
      p = pipeline();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(p.provider.generate).mockImplementation(async () => {
      entered();
      await gate;
      return {
        text: JSON.stringify({
          speech: "This delayed report is still uncertain.",
        }),
        completed: true,
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      };
    });
    const pending = p.run(world, npc, row.id);
    try {
      await Promise.race([
        started,
        pending.then(() => {
          throw Error("Pipeline ended before dispatch.");
        }),
      ]);
      expect(await store.reconcile(s)).toBe("active");
      expect(await p.run(world, npc, row.id)).toMatchObject({
        error: "ineligible",
      });
      await database.pool.query(
        "update interactions set response_claimed_at=clock_timestamp()-interval '11 minutes' where id=$1",
        [row.id],
      );
      expect(await store.reconcile(s)).toBe("reconciled_uncertain");
    } finally {
      release();
    }
    expect(await pending).toMatchObject({ error: "claim_lost" });
    expect(p.provider.generate).toHaveBeenCalledTimes(1);
    expect(p.budget.reserve).toHaveBeenCalledTimes(1);
    expect((await read(s))?.responseText).toBeNull();
  });
  it("allows exactly one paid generation under concurrent independent transactions", async () => {
    const row = await interaction(),
      p = pipeline();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => p.run(world, npc, row.id)),
    );
    expect(results.some((r) => r.ok)).toBe(true);
    expect(p.provider.generate).toHaveBeenCalledTimes(1);
    expect(p.budget.reserve).toHaveBeenCalledTimes(1);
    expect(await read(scope(row.id))).toMatchObject({
      status: "responded",
      responseGenerationOutcome: "responded",
      responsePromptVersion: "npc-speech-v1",
      completedAt: null,
      responseMessageId: null,
    });
    expect(await store.reconcile(scope(row.id))).toBe("responded");
  });
  it("retains immutable speech and does not transition responded to failed or completed", async () => {
    const row = await interaction(),
      p = pipeline();
    expect((await p.run(world, npc, row.id)).ok).toBe(true);
    const saved = (await read(scope(row.id)))!;
    await expect(
      recordInteractionResponse(database.db, world, npc, row.id, {
        responseText: "overwrite",
      }),
    ).rejects.toThrow("already");
    await store.fail(scope(row.id), saved.responseClaimId!, true);
    expect(await read(scope(row.id))).toEqual(saved);
    expect(await p.run(world, npc, row.id)).toMatchObject({
      ok: true,
      status: "already_recorded",
    });
    expect(p.provider.generate).toHaveBeenCalledTimes(1);
  });
  it("enforces world/NPC scope for claims, dispatch, persistence and recovery", async () => {
    const row = await interaction(),
      wrongWorld = { ...scope(row.id), worldId: foreignWorld },
      wrongNpc = { ...scope(row.id), npcId: otherNpc };
    expect(await store.claim(wrongWorld, row)).toBeNull();
    expect(await store.claim(wrongNpc, row)).toBeNull();
    expect(await store.dispatch(wrongWorld, randomUUID())).toBe(false);
    expect(await store.persist(wrongNpc, randomUUID(), "text")).toBeNull();
    expect(await store.reconcile(wrongWorld)).toBe("not_found");
    expect((await read(scope(row.id)))?.status).toBe("received");
  });
  it("never steals a live claim and recovers a pre-dispatch interruption only to failed", async () => {
    const row = await interaction(),
      s = scope(row.id),
      claimed = (await store.claim(s, row))!;
    expect(await store.reconcile(s)).toBe("active");
    expect(await store.claim(s, row)).toBeNull();
    await database.pool.query(
      "update interactions set response_claimed_at=clock_timestamp()-interval '11 minutes' where id=$1",
      [row.id],
    );
    expect(await store.dispatch(s, claimed.responseClaimId!)).toBe(false);
    expect(await store.reconcile(s)).toBe("reconciled_failed");
    expect(await store.reconcile(s)).toBe("terminal");
    const p = pipeline();
    expect(await p.run(world, npc, row.id)).toMatchObject({
      error: "ineligible",
    });
    expect(p.provider.generate).not.toHaveBeenCalled();
    expect((await read(s))?.responseGenerationOutcome).toBe("failed");
  });
  it("fences a stale dispatched worker and never regenerates an uncertain result", async () => {
    const row = await interaction(),
      s = scope(row.id),
      claimed = (await store.claim(s, row))!;
    expect(await store.dispatch(s, claimed.responseClaimId!)).toBe(true);
    expect(await store.dispatch(s, claimed.responseClaimId!)).toBe(false);
    await database.pool.query(
      "update interactions set response_claimed_at=clock_timestamp()-interval '11 minutes' where id=$1",
      [row.id],
    );
    expect(await store.reconcile(s)).toBe("reconciled_uncertain");
    expect(
      await store.persist(s, claimed.responseClaimId!, "late response"),
    ).toBeNull();
    expect((await read(s))?.status).toBe("failed");
    expect((await read(s))?.responseText).toBeNull();
  });
  it("rolls back invalid persistence without losing the dispatched claim", async () => {
    const row = await interaction(),
      s = scope(row.id),
      claimed = (await store.claim(s, row))!;
    await store.dispatch(s, claimed.responseClaimId!);
    await expect(
      store.persist(s, claimed.responseClaimId!, " "),
    ).rejects.toThrow();
    expect(await read(s)).toMatchObject({
      status: "processing",
      responseGenerationOutcome: "dispatched",
      responseText: null,
    });
    await store.fail(s, claimed.responseClaimId!, false);
    expect((await read(s))?.status).toBe("failed");
  });
  it("rejects malformed partial claim metadata at the database boundary", async () => {
    const row = await interaction();
    await expect(
      database.pool.query(
        "update interactions set response_claim_id=$1 where id=$2",
        [randomUUID(), row.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await read(scope(row.id)))?.responseClaimId).toBeNull();
  });
  it("rejects snapshots changed before claim and wrong claim tokens", async () => {
    const row = await interaction(),
      s = scope(row.id);
    expect(
      await store.claim(s, { ...row, requestText: "stale request" }),
    ).toBeNull();
    const claimed = (await store.claim(s, row))!;
    expect(await store.dispatch(s, randomUUID())).toBe(false);
    expect(await store.dispatch(s, claimed.responseClaimId!)).toBe(true);
    expect(await store.persist(s, randomUUID(), "wrong owner")).toBeNull();
    await store.fail(s, claimed.responseClaimId!, false);
  });
  it("blocks unproven routing without changing lifecycle or spending", async () => {
    const row = (await createInteraction(database.db, world, npc, {
      contextId: scene,
      communicationMode: "unknown",
      interactionType: "social",
      requestText: "Mapped Discord request",
    }))!;
    const p = pipeline();
    expect(await p.run(world, npc, row.id)).toMatchObject({
      error: "visibility_blocked",
    });
    expect(p.provider.generate).not.toHaveBeenCalled();
    expect(p.budget.reserve).not.toHaveBeenCalled();
    expect((await read(scope(row.id)))?.status).toBe("received");
  });
  it("does not alter NPC state, knowledge, memory, relationships, tasks or world time", async () => {
    const row = await interaction(),
      p = pipeline(),
      npcBefore = await getNpcWithState(database.db, world, npc);
    const snapshot = async () =>
      Promise.all(
        [
          "npc_knowledge",
          "npc_memories",
          "relationships",
          "tasks",
          "worlds",
        ].map(
          async (table) =>
            (
              await database.pool.query(
                `select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) as records from ${table} t where ${table === "worlds" ? "id" : "world_id"}=$1`,
                [world],
              )
            ).rows,
        ),
      );
    const before = await snapshot();
    expect((await p.run(world, npc, row.id)).ok).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(await getNpcWithState(database.db, world, npc)).toEqual(npcBefore);
    const request = vi.mocked(p.provider.countInput).mock.calls[0][0];
    expect(JSON.stringify(request)).toContain("knowledge_exposure_unproven");
    expect(JSON.stringify(request)).toContain("unknown");
  });
  it("respects external terminal transitions instead of overwriting them", async () => {
    const row = await interaction(),
      s = scope(row.id),
      claimed = (await store.claim(s, row))!;
    await failInteraction(database.db, world, npc, row.id);
    expect(await store.dispatch(s, claimed.responseClaimId!)).toBe(false);
    expect(await store.persist(s, claimed.responseClaimId!, "text")).toBeNull();
    expect(await store.reconcile(s)).toBe("terminal");
  });
});
