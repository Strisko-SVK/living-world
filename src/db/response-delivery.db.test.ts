import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createDatabaseClient } from "./client.js";
import { createWorld } from "../domains/world/world.repository.js";
import {
  createEntity,
  addEntityAlias,
} from "../domains/entity/entity.repository.js";
import { createNpc } from "../domains/npc/npc.repository.js";
import { peloNpcFixture } from "../domains/npc/npc.test-fixture.js";
import {
  createInteractionContext,
  createInteraction,
  getInteraction,
  completeInteraction,
} from "../domains/interaction/interaction.repository.js";
import {
  mapDiscordContext,
  setNpcPrimaryContext,
  mapDiscordUserToEntity,
} from "../domains/discord-mapping/discord-mapping.repository.js";
import { createDiscordPersistence } from "../adapters/discord/persistence.js";
import { createDiscordIntake } from "../intake/discord-intake.js";
import {
  grantLocalPresence,
  prepareLocalInteraction,
  revokeLocalPresence,
} from "../communication/local.repository.js";
import { createResponseStore } from "../response/response.repository.js";
import { createDeliveryRepository } from "../delivery/delivery.repository.js";
import { createDeliveryDispatcher } from "../delivery/dispatch.js";
import {
  fakeAcknowledgement,
  fakeDeliveryTransport,
} from "../delivery/delivery.test-fixture.js";
import {
  LEASE_MS,
  MAX_ATTEMPTS,
  type DeliveryScope,
} from "../delivery/contracts.js";

const database = createDatabaseClient();
const ownedWorlds: string[] = [];
const generation = createResponseStore(database.db);
let serial = 0n;
async function fixture(
  fallback = false,
  thread = true,
  speech = "@everyone @here <@123> <@&456> The report remains uncertain.",
) {
  const world = (
    await createWorld(database.db, {
      key: "delivery-test-" + randomUUID(),
      name: "Isolated delivery test",
      systemType: "test",
    })
  ).id;
  ownedWorlds.push(world);
  const place = (
    await createEntity(database.db, world, {
      entityType: "location",
      canonicalName: "Original location",
    })
  ).id;
  const npc = (
    await createNpc(database.db, world, {
      ...peloNpcFixture,
      canonicalName: "Pelo",
      initialState: {
        ...peloNpcFixture.initialState,
        currentLocationId: place,
        locationCertainty: "certain",
      },
    })
  ).entityId;
  const pc = (
    await createEntity(database.db, world, {
      entityType: "player_character",
      canonicalName: "Player",
    })
  ).id;
  const scene = (
    await createInteractionContext(database.db, world, {
      contextType: "scene",
      linkedLocationEntityId: place,
    })
  ).id;
  const guild = "guild-" + randomUUID(),
    channel = "channel-" + randomUUID(),
    threadId = thread ? "thread-" + randomUUID() : null;
  const mapping = (
    await mapDiscordContext(database.db, world, {
      contextId: scene,
      guildId: guild,
      channelId: channel,
      threadId: fallback ? null : threadId,
      mappingType: "scene",
    })
  ).id;
  await database.pool.query(
    "update interaction_contexts set npc_intake_policy='mapped_players' where id=$1",
    [scene],
  );
  await addEntityAlias(database.db, world, npc, { alias: "Pelo" });
  await mapDiscordUserToEntity(database.db, world, {
    discordUserId: "author",
    entityId: pc,
    mappingType: "player_character",
  });
  const grant = await grantLocalPresence(database.db, {
    worldId: world,
    npcId: npc,
    contextId: scene,
  });
  if (grant.status !== "granted") throw Error("No fixture grant");
  let ms = 0;
  await vi.waitFor(
    async () => {
      const {
        rows: [row],
      } = await database.pool.query(
        "select floor(extract(epoch from clock_timestamp())*1000)::text as millis",
      );
      ms = Number(row.millis);
      expect(ms).toBeGreaterThan(grant.evidence.issuedAt.getTime());
    },
    { timeout: 1000, interval: 1 },
  );
  const message = {
    sourceMessageId: String(((BigInt(ms) - 1420070400000n) << 22n) + ++serial),
    guildId: guild,
    channelId: channel,
    threadId,
    authorId: "author",
    content: "<@123> [Pelo] Check the manifest.",
    mentionedUserIds: ["123"],
  };
  const intake = createDiscordIntake(createDiscordPersistence(database.db));
  expect(await intake(message, "123")).toBe("accepted");
  const {
    rows: [incoming],
  } = await database.pool.query(
    "select id from interactions where world_id=$1",
    [world],
  );
  const scope: DeliveryScope = {
    worldId: world,
    npcId: npc,
    interactionId: incoming.id,
  };
  expect(
    (
      await prepareLocalInteraction(database.db, {
        ...scope,
        contextId: scene,
        evidenceId: grant.evidence.id,
      })
    ).status,
  ).toBe("prepared");
  const local = (await getInteraction(database.db, world, npc, incoming.id))!;
  const claimed = await generation.claim(scope, local);
  if (!claimed?.responseClaimId) throw Error("No fake generation claim");
  expect(await generation.dispatch(scope, claimed.responseClaimId)).toBe(true);
  await generation.persist(scope, claimed.responseClaimId, speech);
  let now = new Date("2030-01-01T00:00:00Z");
  const clock = () => new Date(now);
  const avatars = new Map<string, string>();
  const repository = createDeliveryRepository(database.db, { clock, avatars });
  const fake = fakeDeliveryTransport(new Set([world]));
  const run = createDeliveryDispatcher(repository, fake);
  const read = () => getInteraction(database.db, world, npc, incoming.id);
  const outbox = async () =>
    (
      await database.pool.query(
        "select * from npc_response_deliveries where world_id=$1 and interaction_id=$2",
        [world, incoming.id],
      )
    ).rows[0];
  return {
    world,
    npc,
    pc,
    scene,
    place,
    guild,
    channel,
    threadId,
    mapping,
    scope,
    grant: grant.evidence,
    repository,
    fake,
    run,
    read,
    outbox,
    intake,
    message,
    avatars,
    clock,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  for (const id of ownedWorlds.splice(0)) {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      for (const query of [
        "delete from npc_response_deliveries where world_id=$1",
        "delete from interactions where world_id=$1",
        "delete from local_presence where world_id=$1",
        "delete from discord_context_mappings where world_id=$1",
        "delete from discord_identities where world_id=$1",
        "delete from interaction_contexts where world_id=$1",
        "delete from entity_aliases where entity_id in(select id from entities where world_id=$1)",
        "delete from npc_capabilities where npc_id in(select id from entities where world_id=$1)",
        "delete from npc_game_profiles where npc_id in(select id from entities where world_id=$1)",
        "delete from npc_state where npc_id in(select id from entities where world_id=$1)",
        "delete from npcs where entity_id in(select id from entities where world_id=$1)",
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
});
afterAll(async () => database.close());
async function markSending() {
  await f.repository.prepare(f.scope);
  const claimed = (await f.repository.claim(f.scope))!;
  const sending = (await f.repository.preflight(f.scope, claimed.attemptId!))!;
  return {
    sending,
    ack: fakeAcknowledgement({
      payload: sending.payload,
      attemptId: sending.attemptId!,
      fingerprint: sending.fingerprint,
    }),
  };
}
describe("durable direct-reply delivery", () => {
  it("does not enqueue historical/generated responses automatically", async () => {
    expect((await f.read())?.status).toBe("responded");
    expect(await f.outbox()).toBeUndefined();
    expect(f.fake.send).not.toHaveBeenCalled();
  });
  it("binds the original authenticated scene and mapping and preserves thread/identity/mention policy", async () => {
    const primary = await createInteractionContext(database.db, f.world, {
      contextType: "npc_primary",
    });
    await mapDiscordContext(database.db, f.world, {
      contextId: primary.id,
      mappingType: "npc_primary",
      guildId: f.guild,
      channelId: "primary-channel",
    });
    await setNpcPrimaryContext(database.db, f.world, f.npc, primary.id);
    const before = (await f.read())!;
    expect(before).toMatchObject({
      sourceGuildId: f.guild,
      sourceChannelId: f.channel,
      sourceThreadId: f.threadId,
      sourceMappingId: f.mapping,
    });
    expect((await f.repository.prepare(f.scope)).status).toBe("prepared");
    expect(await f.run(f.scope)).toEqual({ status: "delivered" });
    const request = f.fake.sent[0];
    expect(request.payload.destination).toEqual({
      provider: "discord",
      guildId: f.guild,
      channelId: f.channel,
      threadId: f.threadId,
    });
    expect(request.payload.identity).toEqual({
      displayName: "Pelo",
      avatarUrl: null,
    });
    expect(request.payload.allowedMentions).toEqual({
      parse: [],
      users: [],
      roles: [],
      repliedUser: false,
    });
    expect(request.payload.content).toBe(before.responseText);
    expect(await f.read()).toEqual({
      ...before,
      responseMessageId: "fake:verified-ack",
    });
    expect((await f.outbox()).status).toBe("delivered");
    expect(await f.repository.prepare(f.scope)).toMatchObject({
      status: "existing",
    });
    expect(await f.run(f.scope)).toEqual({ status: "not_claimed" });
    expect(f.fake.send).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])(
    "supports original parent fallback with thread=%s",
    async (thread) => {
      const other = await fixture(true, thread);
      expect((await other.repository.prepare(other.scope)).status).toBe(
        "prepared",
      );
      expect((await other.run(other.scope)).status).toBe("delivered");
      expect(other.fake.sent[0].payload.destination.threadId).toBe(
        other.threadId,
      );
    },
  );
  it("serializes duplicate prepare/replayed intake and independent parallel workers", async () => {
    const prepared = await Promise.all(
      Array.from({ length: 12 }, () => f.repository.prepare(f.scope)),
    );
    expect(prepared.filter((r) => r.status === "prepared")).toHaveLength(1);
    expect(prepared.filter((r) => r.status === "existing")).toHaveLength(11);
    const before = await f.read();
    expect(await f.intake(f.message, "123")).toBe("duplicate");
    expect(await f.read()).toEqual(before);
    const second = createDeliveryDispatcher(
      createDeliveryRepository(database.db, { clock: f.clock }),
      f.fake,
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 ? second(f.scope) : f.run(f.scope),
      ),
    );
    expect(results.filter((r) => r.status === "delivered")).toHaveLength(1);
    expect(f.fake.send).toHaveBeenCalledTimes(1);
    expect(
      (
        await database.pool.query(
          "select count(*) from npc_response_deliveries where interaction_id=$1",
          [f.scope.interactionId],
        )
      ).rows[0].count,
    ).toBe("1");
  });
  it.each([
    "presence",
    "policy",
    "scene",
    "world",
    "entity",
    "npc",
    "state",
    "location",
  ] as const)("blocks revoked/stale %s before preparation", async (change) => {
    if (change === "presence")
      await revokeLocalPresence(
        database.db,
        { worldId: f.world, npcId: f.npc, contextId: f.scene },
        f.grant.id,
      );
    if (change === "policy")
      await database.pool.query(
        "update interaction_contexts set npc_intake_policy='disabled' where id=$1",
        [f.scene],
      );
    if (change === "scene")
      await database.pool.query(
        "update interaction_contexts set status='inactive' where id=$1",
        [f.scene],
      );
    if (change === "world")
      await database.pool.query(
        "update worlds set status='archived' where id=$1",
        [f.world],
      );
    if (change === "entity")
      await database.pool.query(
        "update entities set status='inactive' where id=$1",
        [f.npc],
      );
    if (change === "npc")
      await database.pool.query(
        "update npcs set lifecycle_state='dormant' where entity_id=$1",
        [f.npc],
      );
    if (change === "state")
      await database.pool.query(
        "update npc_state set version=version+1 where npc_id=$1",
        [f.npc],
      );
    if (change === "location")
      await database.pool.query(
        "update npc_state set location_certainty='unknown' where npc_id=$1",
        [f.npc],
      );
    expect((await f.repository.prepare(f.scope)).status).toBe("blocked");
    expect(await f.outbox()).toBeUndefined();
    expect((await f.run(f.scope)).status).toBe("not_claimed");
    expect(f.fake.send).not.toHaveBeenCalled();
  });
  it.each(["received", "processing", "failed"])(
    "does not deliver generation status %s",
    async (status) => {
      await database.pool.query(
        "update interactions set status=$1 where id=$2",
        [status, f.scope.interactionId],
      );
      expect(await f.repository.prepare(f.scope)).toMatchObject({
        status: "blocked",
        reason: "response_unavailable",
      });
    },
  );
  it.each([
    "deleted",
    "inactive",
    "remapped",
    "ambiguous",
    "new_exact",
  ] as const)("fails closed for %s original route", async (change) => {
    if (change === "new_exact") {
      const other = await fixture(true);
      f = other;
      await mapDiscordContext(database.db, f.world, {
        guildId: f.guild,
        channelId: f.channel,
        threadId: f.threadId,
        contextId: f.scene,
        mappingType: "scene",
      });
    } else if (change === "deleted")
      await database.pool.query(
        "delete from discord_context_mappings where id=$1",
        [f.mapping],
      );
    else if (change === "inactive")
      await database.pool.query(
        "update discord_context_mappings set status='inactive' where id=$1",
        [f.mapping],
      );
    else if (change === "remapped") {
      const other = await createInteractionContext(database.db, f.world, {
        contextType: "scene",
      });
      await database.pool.query(
        "update discord_context_mappings set context_id=$1 where id=$2",
        [other.id, f.mapping],
      );
    } else {
      const other = await fixture();
      await mapDiscordContext(database.db, other.world, {
        guildId: f.guild,
        channelId: f.channel,
        threadId: f.threadId,
        contextId: other.scene,
        mappingType: "scene",
      });
    }
    expect(await f.repository.prepare(f.scope)).toMatchObject({
      status: "blocked",
      reason: "route_untrusted",
    });
    expect(f.fake.send).not.toHaveBeenCalled();
  });
  it.each(["claim", "preflight"] as const)(
    "revalidates policy/route/presence at %s",
    async (phase) => {
      await f.repository.prepare(f.scope);
      if (phase === "claim") {
        await database.pool.query(
          "update interaction_contexts set npc_intake_policy='disabled' where id=$1",
          [f.scene],
        );
        expect(await f.repository.claim(f.scope)).toBeNull();
      } else {
        const claim = (await f.repository.claim(f.scope))!;
        await revokeLocalPresence(
          database.db,
          { worldId: f.world, npcId: f.npc, contextId: f.scene },
          f.grant.id,
        );
        expect(
          await f.repository.preflight(f.scope, claim.attemptId!),
        ).toBeNull();
      }
      expect((await f.outbox()).status).toBe("blocked");
      expect(f.fake.send).not.toHaveBeenCalled();
    },
  );
  it("revalidates route replacement between claim and preflight", async () => {
    await f.repository.prepare(f.scope);
    const claim = (await f.repository.claim(f.scope))!;
    await database.pool.query(
      "delete from discord_context_mappings where id=$1",
      [f.mapping],
    );
    await mapDiscordContext(database.db, f.world, {
      guildId: f.guild,
      channelId: f.channel,
      threadId: f.threadId,
      contextId: f.scene,
      mappingType: "scene",
    });
    expect(await f.repository.preflight(f.scope, claim.attemptId!)).toBeNull();
    expect((await f.outbox()).status).toBe("blocked");
  });
  it("allows only safe bounded retries honoring no-send retry-after", async () => {
    const fake = fakeDeliveryTransport(new Set([f.world]), async () => ({
      kind: "not_sent",
      retryable: true,
      retryAfterMs: 5000,
    }));
    const run = createDeliveryDispatcher(f.repository, fake);
    await f.repository.prepare(f.scope);
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      expect((await run(f.scope)).status).toBe(
        i === MAX_ATTEMPTS ? "failed" : "retryable",
      );
      expect((await f.outbox()).attempts).toBe(i);
      expect((await run(f.scope)).status).toBe("not_claimed");
      f.advance(5000);
    }
    expect((await run(f.scope)).status).toBe("not_claimed");
    expect(fake.send).toHaveBeenCalledTimes(3);
    expect((await f.read())?.responseMessageId).toBeNull();
  });
  it("retries a known-unsent transient failure then records one acknowledgement", async () => {
    await f.repository.prepare(f.scope);
    f.fake.send.mockResolvedValueOnce({
      kind: "not_sent",
      retryable: true,
      retryAfterMs: 1000,
    });
    expect((await f.run(f.scope)).status).toBe("retryable");
    f.advance(1000);
    expect((await f.run(f.scope)).status).toBe("delivered");
    expect(f.fake.send).toHaveBeenCalledTimes(2);
    expect((await f.outbox()).attempts).toBe(2);
  });
  it("keeps permanent known-unsent failure terminal", async () => {
    await f.repository.prepare(f.scope);
    f.fake.send.mockResolvedValueOnce({
      kind: "not_sent",
      retryable: false,
      retryAfterMs: 0,
    });
    expect((await f.run(f.scope)).status).toBe("failed");
    f.advance(100000);
    expect((await f.run(f.scope)).status).toBe("not_claimed");
  });
  it.each(["throw", "ambiguous", "invalid_ack"] as const)(
    "never automatically resends %s transport outcomes",
    async (kind) => {
      await f.repository.prepare(f.scope);
      f.fake.send.mockImplementationOnce(async (req) => {
        if (kind === "throw") throw Error("private transport details");
        if (kind === "ambiguous") return { kind: "uncertain" };
        return {
          kind: "acknowledged",
          ack: { ...fakeAcknowledgement(req), attemptId: randomUUID() },
        };
      });
      expect((await f.run(f.scope)).status).toBe("uncertain");
      f.advance(LEASE_MS * 2);
      expect((await f.repository.recover(f.scope))?.status).toBe("uncertain");
      expect((await f.run(f.scope)).status).toBe("not_claimed");
      expect(f.fake.send).toHaveBeenCalledTimes(1);
      expect((await f.read())?.responseMessageId).toBeNull();
    },
  );
  it("recovers a pre-dispatch crash safely and fences the old token", async () => {
    await f.repository.prepare(f.scope);
    const first = (await f.repository.claim(f.scope))!;
    f.advance(LEASE_MS);
    expect((await f.repository.recover(f.scope))?.status).toBe("retryable");
    f.advance(1000);
    const second = (await f.repository.claim(f.scope))!;
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(await f.repository.preflight(f.scope, first.attemptId!)).toBeNull();
    expect(
      (await f.repository.preflight(f.scope, second.attemptId!))?.status,
    ).toBe("sending");
  });
  it("recovers a possible-send crash as uncertain and requires explicit reconciliation", async () => {
    const { sending, ack } = await markSending();
    f.advance(LEASE_MS);
    expect((await f.repository.recover(f.scope))?.status).toBe("uncertain");
    expect(await f.repository.acknowledge(f.scope, ack)).toBe(false);
    expect((await f.run(f.scope)).status).toBe("not_claimed");
    expect(
      await f.repository.reconcile(f.scope, sending.attemptId!, {
        kind: "delivered",
        ack,
        evidence: "operator:verified-message",
      }),
    ).toBe(true);
    expect(await f.read()).toMatchObject({
      status: "responded",
      responseMessageId: ack.messageId,
    });
    const saved = await f.outbox();
    expect(saved).toMatchObject({
      status: "delivered",
      reconciliation_evidence: "operator:verified-message",
    });
    expect(saved.reconciled_by).toEqual(expect.any(String));
    expect((await f.run(f.scope)).status).toBe("not_claimed");
  });
  it("requires operator proof of no send before retrying uncertainty", async () => {
    const { sending, ack } = await markSending();
    await f.repository.fail(f.scope, sending.attemptId!, { kind: "uncertain" });
    expect(
      await f.repository.reconcile(f.scope, randomUUID(), {
        kind: "not_sent",
        evidence: "operator:no-send",
      }),
    ).toBe(false);
    expect(
      await f.repository.reconcile(f.scope, sending.attemptId!, {
        kind: "not_sent",
        evidence: "operator:no-send",
      }),
    ).toBe(true);
    expect(await f.repository.acknowledge(f.scope, ack)).toBe(false);
    f.advance(1000);
    expect((await f.run(f.scope)).status).toBe("delivered");
  });
  it.each(["attempt", "fingerprint", "route", "source_id"] as const)(
    "fences invalid %s acknowledgement",
    async (mismatch) => {
      const { ack } = await markSending();
      if (mismatch === "attempt") ack.attemptId = randomUUID();
      if (mismatch === "fingerprint") ack.fingerprint = "a".repeat(64);
      if (mismatch === "route") ack.destination.threadId = "wrong-thread";
      if (mismatch === "source_id") ack.messageId = f.message.sourceMessageId;
      expect(await f.repository.acknowledge(f.scope, ack)).toBe(false);
      expect((await f.outbox()).status).toBe("sending");
      expect((await f.read())?.responseMessageId).toBeNull();
    },
  );
  it("acknowledges once and fences overwrites and payload tampering in PostgreSQL", async () => {
    const { ack } = await markSending();
    expect(await f.repository.acknowledge(f.scope, ack)).toBe(true);
    expect(await f.repository.acknowledge(f.scope, ack)).toBe(true);
    expect(
      await f.repository.acknowledge(f.scope, { ...ack, messageId: "other" }),
    ).toBe(false);
    for (const query of [
      "update interactions set response_message_id='forged' where id=$1",
      "update interactions set response_text='rewritten' where id=$1",
      "update interactions set source_thread_id='changed' where id=$1",
      "update npc_response_deliveries set payload='{}' where interaction_id=$1",
      "update npc_response_deliveries set status='pending' where interaction_id=$1",
    ])
      await expect(
        database.pool.query(query, [f.scope.interactionId]),
      ).rejects.toMatchObject({ code: "23514" });
  });
  it("does not accept an unverified message reference before ACK", async () => {
    await f.repository.prepare(f.scope);
    await expect(
      database.pool.query(
        "update interactions set response_message_id='forged' where id=$1",
        [f.scope.interactionId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it.each(["world", "npc", "interaction"] as const)(
    "isolates wrong-%s scope through all lifecycle operations",
    async (mismatch) => {
      const { sending, ack } = await markSending();
      const scope = {
        ...f.scope,
        [{ world: "worldId", npc: "npcId", interaction: "interactionId" }[
          mismatch
        ]]: randomUUID(),
      };
      expect((await f.repository.prepare(scope)).status).toBe("blocked");
      expect(await f.repository.claim(scope)).toBeNull();
      expect(
        await f.repository.preflight(scope, sending.attemptId!),
      ).toBeNull();
      expect(await f.repository.acknowledge(scope, ack)).toBe(false);
      expect(
        await f.repository.reconcile(scope, sending.attemptId!, {
          kind: "not_sent",
          evidence: "operator:proof",
        }),
      ).toBe(false);
      expect(await f.repository.recover(scope)).toBeNull();
    },
  );
  it.each(["name", "avatar", "oversized"] as const)(
    "rejects unsafe %s before outbox creation",
    async (unsafe) => {
      if (unsafe === "name")
        await database.pool.query(
          "update entities set canonical_name='@everyone' where id=$1",
          [f.npc],
        );
      if (unsafe === "avatar")
        f.avatars.set(`${f.world}:${f.npc}`, "https://localhost/secret");
      if (unsafe === "oversized")
        f = await fixture(false, true, "x".repeat(2001));
      expect((await f.repository.prepare(f.scope)).status).toBe("blocked");
      expect(f.fake.send).not.toHaveBeenCalled();
    },
  );
  it("blocks renamed identity after preparation instead of changing the immutable snapshot", async () => {
    await f.repository.prepare(f.scope);
    await database.pool.query(
      "update entities set canonical_name='Renamed' where id=$1",
      [f.npc],
    );
    expect(await f.repository.claim(f.scope)).toBeNull();
    expect((await f.outbox()).last_code).toBe("snapshot_changed");
  });
  it("fails closed for legacy generated rows without an original route snapshot", async () => {
    const row = (await createInteraction(database.db, f.world, f.npc, {
      contextId: f.scene,
      communicationMode: "unknown",
      interactionType: "social",
      requestText: "Legacy response",
      sourceProvider: "discord",
      sourceMessageId: String(BigInt(f.message.sourceMessageId) + 1n),
    }))!;
    const scope = { ...f.scope, interactionId: row.id };
    expect(
      (
        await prepareLocalInteraction(database.db, {
          ...scope,
          contextId: f.scene,
          evidenceId: f.grant.id,
        })
      ).status,
    ).toBe("prepared");
    const local = (await getInteraction(database.db, f.world, f.npc, row.id))!;
    const claim = (await generation.claim(scope, local))!;
    await generation.dispatch(scope, claim.responseClaimId!);
    await generation.persist(
      scope,
      claim.responseClaimId!,
      "Previously generated speech.",
    );
    expect(await f.repository.prepare(scope)).toMatchObject({
      status: "blocked",
      reason: "route_untrusted",
    });
    expect((await f.run(scope)).status).toBe("not_claimed");
    expect(f.fake.send).not.toHaveBeenCalled();
  });
  it("preserves completed interaction lifecycle while recording delivery", async () => {
    await completeInteraction(
      database.db,
      f.world,
      f.npc,
      f.scope.interactionId,
    );
    const before = (await f.read())!;
    await f.repository.prepare(f.scope);
    expect((await f.run(f.scope)).status).toBe("delivered");
    expect(await f.read()).toEqual({
      ...before,
      responseMessageId: "fake:verified-ack",
    });
  });
  it("recovers a lost database ACK confirmation without sending again", async () => {
    await f.repository.prepare(f.scope);
    const repository = {
      ...f.repository,
      acknowledge: async (
        ...args: Parameters<typeof f.repository.acknowledge>
      ) => {
        await f.repository.acknowledge(...args);
        throw Error("Lost commit confirmation");
      },
    };
    const run = createDeliveryDispatcher(repository, f.fake);
    expect((await run(f.scope)).status).toBe("delivered");
    expect((await run(f.scope)).status).toBe("not_claimed");
    expect(f.fake.send).toHaveBeenCalledTimes(1);
  });
  it("rechecks a repeated pending preparation after policy revocation", async () => {
    await f.repository.prepare(f.scope);
    await database.pool.query(
      "update interaction_contexts set npc_intake_policy='disabled' where id=$1",
      [f.scene],
    );
    expect(await f.repository.prepare(f.scope)).toMatchObject({
      status: "blocked",
      reason: "policy_disabled",
    });
    expect((await f.outbox()).status).toBe("blocked");
  });
  it.each(["mapping", "policy", "presence"] as const)(
    "serializes a delivery claim against a committed %s writer",
    async (kind) => {
      await f.repository.prepare(f.scope);
      const client = await database.pool.connect();
      let claiming: ReturnType<typeof f.repository.claim> | undefined;
      try {
        await client.query("BEGIN");
        if (kind === "mapping")
          await client.query(
            "update discord_context_mappings set status='inactive' where id=$1",
            [f.mapping],
          );
        if (kind === "policy")
          await client.query(
            "update interaction_contexts set npc_intake_policy='disabled' where id=$1",
            [f.scene],
          );
        if (kind === "presence")
          await client.query(
            "update local_presence set revoked_at=clock_timestamp(),revoked_by=current_user where id=$1",
            [f.grant.id],
          );
        const {
          rows: [writer],
        } = await client.query("select pg_backend_pid() as pid");
        claiming = f.repository.claim(f.scope);
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
        expect((await f.outbox()).status).toBe("blocked");
        expect(f.fake.send).not.toHaveBeenCalled();
      } finally {
        await client.query("ROLLBACK");
        client.release();
        await claiming;
      }
    },
  );
  it("records ACK fact even if authorization is revoked after the pre-send boundary", async () => {
    const fake = fakeDeliveryTransport(new Set([f.world]), async (req) => {
      await revokeLocalPresence(
        database.db,
        { worldId: f.world, npcId: f.npc, contextId: f.scene },
        f.grant.id,
      );
      return { kind: "acknowledged", ack: fakeAcknowledgement(req) };
    });
    await f.repository.prepare(f.scope);
    expect(
      (await createDeliveryDispatcher(f.repository, fake)(f.scope)).status,
    ).toBe("delivered");
    expect(fake.send).toHaveBeenCalledTimes(1);
  });
});
