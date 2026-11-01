import {
  grantLocalPresence,
  prepareLocalInteraction,
  revokeLocalPresence,
} from "../communication/local.repository.js";
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
          "delete from local_presence where world_id=$1",
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
  const grant = await grantLocalPresence(database.db, {
    worldId: world,
    npcId: npc,
    contextId: context.id,
  });
  if (grant.status !== "granted") throw Error("Fixture grant failed");
  const row = (await createInteraction(database.db, world, npc, {
    contextId: context.id,
    communicationMode: "unknown",
    interactionType: "social",
    requestText: "Check the manifest",
  }))!;
  const prepared = await prepareLocalInteraction(database.db, {
    worldId: world,
    npcId: npc,
    contextId: context.id,
    interactionId: row.id,
    evidenceId: grant.evidence.id,
  });
  if (prepared.status !== "prepared") throw Error("Fixture preparation failed");
  return prepared.interaction;
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
  it("prepares exactly once under parallel requests and preserves duplicate event identity", async () => {
    const context = await createInteractionContext(database.db, world, {
      contextType: "scene",
      linkedLocationEntityId: locationId,
    });
    const grant = await grantLocalPresence(database.db, {
      worldId: world,
      npcId: npc,
      contextId: context.id,
    });
    if (grant.status !== "granted") throw Error("No grant");
    const request = {
      contextId: context.id,
      communicationMode: "unknown" as const,
      interactionType: "social" as const,
      requestText: "Original request",
      sourceProvider: "test",
      sourceMessageId: randomUUID(),
    };
    const row = (await createInteraction(database.db, world, npc, request))!;
    const input = {
      worldId: world,
      npcId: npc,
      contextId: context.id,
      interactionId: row.id,
      evidenceId: grant.evidence.id,
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        prepareLocalInteraction(database.db, input),
      ),
    );
    expect(results.filter((r) => r.status === "prepared")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_prepared")).toHaveLength(
      7,
    );
    const saved = (await read(scope(row.id)))!;
    expect(saved).toEqual({
      ...row,
      communicationMode: "local",
      localPresenceId: grant.evidence.id,
    });
    expect(
      await createInteraction(database.db, world, npc, {
        ...request,
        requestText: "Overwrite attempt",
      }),
    ).toEqual(saved);
    const p = pipeline();
    expect((await p.run(world, npc, row.id)).ok).toBe(true);
    expect(await prepareLocalInteraction(database.db, input)).toMatchObject({
      status: "conflict",
    });
  });
  it.each([
    "missing",
    "revoked",
    "wrong_scene",
    "late",
    "uncertain",
    "mismatch",
    "inactive_npc",
    "inactive_entity",
    "inactive_world",
    "inactive_scene",
    "remote",
  ] as const)(
    "leaves unknown input unchanged when blocked by %s",
    async (change) => {
      const context = await createInteractionContext(database.db, world, {
        contextType: "scene",
        linkedLocationEntityId: locationId,
      });
      const s = { worldId: world, npcId: npc, contextId: context.id };
      let row;
      const request = {
        contextId: context.id,
        communicationMode:
          change === "remote" ? ("remote" as const) : ("unknown" as const),
        interactionType: "social" as const,
        requestText: "Unprepared request",
      };
      if (change === "late")
        row = (await createInteraction(database.db, world, npc, request))!;
      const grant = await grantLocalPresence(database.db, s);
      if (grant.status !== "granted") throw Error("No grant");
      row ??= (await createInteraction(database.db, world, npc, request))!;
      if (change === "revoked")
        await revokeLocalPresence(database.db, s, grant.evidence.id);
      if (change === "uncertain")
        await database.pool.query(
          "update npc_state set location_certainty='unknown' where npc_id=$1",
          [npc],
        );
      if (change === "mismatch")
        await database.pool.query(
          "update npc_state set current_location_id=null where npc_id=$1",
          [npc],
        );
      if (change === "inactive_npc")
        await database.pool.query(
          "update npcs set lifecycle_state='dormant' where entity_id=$1",
          [npc],
        );
      if (change === "inactive_entity")
        await database.pool.query(
          "update entities set status='inactive' where id=$1",
          [npc],
        );
      if (change === "inactive_world")
        await database.pool.query(
          "update worlds set status='archived' where id=$1",
          [world],
        );
      if (change === "inactive_scene")
        await database.pool.query(
          "update interaction_contexts set status='inactive' where id=$1",
          [context.id],
        );
      try {
        const result = await prepareLocalInteraction(database.db, {
          ...s,
          interactionId: row.id,
          evidenceId:
            change === "missing"
              ? randomUUID()
              : change === "wrong_scene"
                ? (await interaction()).localPresenceId!
                : grant.evidence.id,
        });
        expect(result.status).toBe("blocked");
        expect(await read(scope(row.id))).toEqual(row);
      } finally {
        await database.pool.query(
          "update npc_state set current_location_id=$1,location_certainty='certain' where npc_id=$2",
          [locationId, npc],
        );
        await database.pool.query(
          "update npcs set lifecycle_state='active' where entity_id=$1",
          [npc],
        );
        await database.pool.query(
          "update entities set status='active' where id=$1",
          [npc],
        );
        await database.pool.query(
          "update worlds set status='active' where id=$1",
          [world],
        );
      }
    },
  );
  it("rejects a pre-grant event within the same millisecond", async () => {
    const row = await interaction();
    const incoming = (await createInteraction(database.db, world, npc, {
      contextId: row.contextId,
      communicationMode: "unknown",
      interactionType: "social",
      requestText: "Earlier receipt",
    }))!;
    await database.pool.query(
      "update interactions set created_at=(select issued_at-interval '1 microsecond' from local_presence where id=$1) where id=$2",
      [row.localPresenceId, incoming.id],
    );
    expect(
      await prepareLocalInteraction(database.db, {
        worldId: world,
        npcId: npc,
        contextId: row.contextId,
        interactionId: incoming.id,
        evidenceId: row.localPresenceId!,
      }),
    ).toMatchObject({ status: "blocked", reason: "stale" });
  });
  it("waits for committed evidence revocation at claim", async () => {
    const row = await interaction();
    const client = await database.pool.connect();
    let claiming: ReturnType<typeof store.claim> | undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        "update local_presence set revoked_at=clock_timestamp(),revoked_by=current_user where id=$1",
        [row.localPresenceId],
      );
      const {
        rows: [writer],
      } = await client.query("select pg_backend_pid() as pid");
      claiming = store.claim(scope(row.id), row);
      await vi.waitFor(
        async () => {
          const { rows } = await database.pool.query(
            "select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))",
            [writer.pid],
          );
          expect(rows.length).toBeGreaterThan(0);
        },
        { timeout: 1500, interval: 10 },
      );
      await client.query("COMMIT");
      expect(await claiming).toBeNull();
      expect((await read(scope(row.id)))?.responseClaimId).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await claiming;
    }
  });
  it("serializes duplicate preparation and preserves the event", async () => {
    const row = await interaction();
    const input = {
      worldId: world,
      npcId: npc,
      contextId: row.contextId,
      interactionId: row.id,
      evidenceId: row.localPresenceId!,
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        prepareLocalInteraction(database.db, input),
      ),
    );
    expect(results.every((r) => r.status === "already_prepared")).toBe(true);
    expect(await read(scope(row.id))).toEqual(row);
    expect(
      await prepareLocalInteraction(database.db, {
        ...input,
        worldId: foreignWorld,
      }),
    ).toMatchObject({ reason: "missing" });
    expect(
      await prepareLocalInteraction(database.db, { ...input, npcId: otherNpc }),
    ).toMatchObject({ reason: "missing" });
    expect(
      await prepareLocalInteraction(database.db, {
        ...input,
        contextId: scene,
      }),
    ).toMatchObject({ reason: "missing" });
  });
  it("pins a revoked grant permanently across reissue", async () => {
    const row = await interaction();
    const input = { worldId: world, npcId: npc, contextId: row.contextId };
    expect(
      await revokeLocalPresence(database.db, input, row.localPresenceId!),
    ).toMatchObject({ status: "revoked" });
    expect(
      await revokeLocalPresence(database.db, input, row.localPresenceId!),
    ).toMatchObject({ status: "already_revoked" });
    const next = await grantLocalPresence(database.db, input);
    if (next.status !== "granted") throw Error("No grant");
    expect(
      await prepareLocalInteraction(database.db, {
        ...input,
        interactionId: row.id,
        evidenceId: next.evidence.id,
      }),
    ).toMatchObject({ status: "conflict" });
    const p = pipeline();
    expect(await p.run(world, npc, row.id)).toMatchObject({
      error: "ineligible",
    });
    expect(p.provider.generate).not.toHaveBeenCalled();
    await expect(
      database.pool.query(
        "update interactions set local_presence_id=$1 where id=$2",
        [next.evidence.id, row.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.pool.query(
        "update local_presence set revoked_at=null,revoked_by=null where id=$1",
        [row.localPresenceId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it.each(["claim", "dispatch", "preflight", "retry", "generation"] as const)(
    "fences presence revocation at %s",
    async (phase) => {
      const row = await interaction();
      const revoke = () =>
        revokeLocalPresence(
          database.db,
          { worldId: world, npcId: npc, contextId: row.contextId },
          row.localPresenceId!,
        );
      const p = pipeline({
        store: {
          ...store,
          claim: async (...args) => {
            if (phase === "claim") await revoke();
            return store.claim(...args);
          },
          dispatch: async (...args) => {
            if (phase === "dispatch") await revoke();
            return store.dispatch(...args);
          },
        },
      });
      if (phase === "preflight")
        vi.mocked(p.provider.countInput).mockImplementation(async () => {
          await revoke();
          return 10;
        });
      if (phase === "retry" || phase === "generation")
        vi.mocked(p.provider.generate).mockImplementation(async () => {
          await revoke();
          if (phase === "retry")
            throw new ProviderFailure("rate_limit", true, 0, true);
          return {
            text: JSON.stringify({ speech: "This response is forbidden." }),
            completed: true,
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          };
        });
      expect((await p.run(world, npc, row.id)).ok).toBe(false);
      expect((await read(scope(row.id)))?.responseText).toBeNull();
      expect(p.provider.generate).toHaveBeenCalledTimes(
        phase === "generation" || phase === "retry" ? 1 : 0,
      );
      if (phase === "claim" || phase === "dispatch")
        expect(p.budget.reserve).not.toHaveBeenCalled();
    },
  );
  it("blocks stale state versions even when location matches", async () => {
    const row = await interaction();
    await database.pool.query(
      "update npc_state set version=version+1 where npc_id=$1",
      [npc],
    );
    const p = pipeline();
    expect(await p.run(world, npc, row.id)).toMatchObject({
      error: "ineligible",
    });
    expect(p.provider.countInput).not.toHaveBeenCalled();
  });
  it("blocks a disabled Discord context at response claim", async () => {
    const row = await interaction();
    // A prepared event cannot have its source identity rewritten.
    await expect(
      database.pool.query(
        "update interactions set source_provider='discord', source_message_id='forged' where id=$1",
        [row.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const grant = await grantLocalPresence(database.db, {
      worldId: world,
      npcId: npc,
      contextId: scene,
    });
    if (grant.status !== "granted") throw Error("No grant");
    await database.pool.query(
      "update interaction_contexts set npc_intake_policy='mapped_players' where id=$1",
      [scene],
    );
    const incoming = (await createInteraction(database.db, world, npc, {
      contextId: scene,
      communicationMode: "unknown",
      interactionType: "social",
      requestText: "Explicit Discord request",
      sourceProvider: "discord",
      sourceMessageId: randomUUID(),
    }))!;
    const prepared = await prepareLocalInteraction(database.db, {
      worldId: world,
      npcId: npc,
      contextId: scene,
      interactionId: incoming.id,
      evidenceId: grant.evidence.id,
    });
    expect(prepared.status).toBe("prepared");
    await database.pool.query(
      "update interaction_contexts set npc_intake_policy='disabled' where id=$1",
      [scene],
    );
    const p = pipeline();
    expect((await p.run(world, npc, incoming.id)).ok).toBe(false);
    expect(p.provider.generate).not.toHaveBeenCalled();
  });
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
