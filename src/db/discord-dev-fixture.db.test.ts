import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createDatabaseClient } from "./client.js";
import { createWorld } from "../domains/world/world.repository.js";
import { addEntityAlias } from "../domains/entity/entity.repository.js";
import { createDiscordPersistence } from "../adapters/discord/persistence.js";
import { createDiscordIntake } from "../intake/discord-intake.js";
import { mapDiscordUserToEntity } from "../domains/discord-mapping/discord-mapping.repository.js";
import { runContextPolicyCommand } from "../admin/context-intake-policy.js";
import { reconcilePilotPlayer } from "../admin/discord-pilot-player.js";
import {
  provisionDevFixture,
  type DevFixtureRoute,
} from "../admin/discord-dev-fixture.js";

const database = createDatabaseClient();
const createdWorldIds: string[] = [];
const worldKey = () => "fixture-" + randomUUID();
const route = (): DevFixtureRoute => {
  const base =
    1_000_000_000_000_000_000n +
    BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 14));
  return {
    guildId: String(base),
    channelId: String(base + 1n),
    threadId: String(base + 2n),
  };
};

async function apply(key: string, location: DevFixtureRoute) {
  const result = await provisionDevFixture(database.db, location, true, key);
  if (result.status === "created" && result.worldId) {
    createdWorldIds.push(result.worldId);
  }
  return result;
}

async function dbCounts(id: string) {
  const result = await database.pool.query(
    "select " +
      "(select count(*)::int from entities where world_id=$1) as entities, " +
      "(select count(*)::int from interaction_contexts where world_id=$1) as contexts, " +
      "(select count(*)::int from discord_context_mappings where world_id=$1) as routes, " +
      "(select count(*)::int from discord_identities where world_id=$1) as identities, " +
      "(select count(*)::int from interactions where world_id=$1) as interactions, " +
      "(select count(*)::int from npc_response_deliveries where world_id=$1) as deliveries, " +
      "(select count(*)::int from local_presence where world_id=$1) as presence",
    [id],
  );
  return result.rows[0];
}

async function cleanupWorld(id: string) {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of [
      "delete from npc_response_deliveries where world_id=$1",
      "delete from interactions where world_id=$1",
      "delete from local_presence where world_id=$1",
      "delete from context_intake_policy_audit where world_id=$1",
      "delete from discord_identities where world_id=$1",
      "delete from discord_context_mappings where world_id=$1",
      "delete from interaction_contexts where world_id=$1",
      "delete from entity_aliases where entity_id in(select id from entities where world_id=$1)",
      "delete from npc_capabilities where npc_id in(select id from entities where world_id=$1)",
      "delete from npc_game_profiles where npc_id in(select id from entities where world_id=$1)",
      "delete from npc_state where npc_id in(select id from entities where world_id=$1)",
      "delete from npcs where entity_id in(select id from entities where world_id=$1)",
      "delete from entities where world_id=$1",
      "delete from worlds where id=$1",
    ]) {
      await client.query(statement, [id]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

afterEach(async () => {
  for (const id of createdWorldIds.splice(0)) {
    await cleanupWorld(id);
  }
});
afterAll(async () => database.close());

describe("offline synthetic Discord DEV world fixture", () => {
  it("preview makes no writes, first apply creates only expected records", async () => {
    const key = worldKey();
    const location = route();
    expect(
      await provisionDevFixture(database.db, location, false, key),
    ).toEqual({
      status: "would_create",
      worldKey: key,
    });
    const before = await database.pool.query(
      "select id from worlds where key=$1",
      [key],
    );
    expect(before.rows).toHaveLength(0);
    const first = await apply(key, location);
    expect(first.status).toBe("created");
    expect(first.worldId).toBeDefined();
    expect(
      await provisionDevFixture(database.db, location, false, key),
    ).toEqual({
      status: "already_present",
      worldKey: key,
      worldId: first.worldId,
      contextId: first.contextId,
      npcId: first.npcId,
    });
    expect(await dbCounts(first.worldId!)).toEqual({
      entities: 3,
      contexts: 1,
      routes: 1,
      identities: 0,
      interactions: 0,
      deliveries: 0,
      presence: 0,
    });
  });

  it("replays the same apply without duplicate IDs or changing intake policy", async () => {
    const key = worldKey();
    const location = route();
    const first = await apply(key, location);
    const second = await apply(key, location);
    expect(second).toEqual({ ...first, status: "already_present" });
    expect(await dbCounts(first.worldId!)).toMatchObject({
      entities: 3,
      contexts: 1,
      routes: 1,
    });
    const result = await database.pool.query(
      "select npc_intake_policy from interaction_contexts where id=$1",
      [first.contextId],
    );
    expect(result.rows).toEqual([{ npc_intake_policy: "disabled" }]);
  });

  it("serializes concurrent first applications without duplicate resources", async () => {
    const key = worldKey();
    const location = route();
    const results = await Promise.all([
      apply(key, location),
      apply(key, location),
    ]);
    const created = results.filter((item) => item.status === "created");
    const existing = results.filter(
      (item) => item.status === "already_present",
    );
    expect(created).toHaveLength(1);
    expect(existing).toHaveLength(1);
    expect(created[0]!.worldId).toBe(existing[0]!.worldId);
    expect(await dbCounts(created[0]!.worldId!)).toMatchObject({
      entities: 3,
      contexts: 1,
      routes: 1,
    });
  });

  it("rejects a conflicting thread or foreign-world route without changes", async () => {
    const key = worldKey();
    const location = route();
    const first = await apply(key, location);
    await expect(
      provisionDevFixture(
        database.db,
        { ...location, threadId: String(BigInt(location.threadId) + 5n) },
        true,
        key,
      ),
    ).rejects.toThrow("conflicts");
    await expect(
      provisionDevFixture(database.db, location, true, worldKey()),
    ).rejects.toThrow("conflicts");
    expect(await dbCounts(first.worldId!)).toMatchObject({
      entities: 3,
      contexts: 1,
      routes: 1,
    });
  });

  it("fails closed on a partial pre-existing world", async () => {
    const key = worldKey();
    const world = await createWorld(database.db, {
      key,
      name: "Living World DEV - Gateway Lab",
      systemType: "test",
    });
    createdWorldIds.push(world.id);
    await expect(
      provisionDevFixture(database.db, route(), true, key),
    ).rejects.toThrow("conflicts");
    expect(await dbCounts(world.id)).toMatchObject({
      entities: 0,
      contexts: 0,
      routes: 0,
    });
  });

  it("rejects extra alias instead of silently repairing it", async () => {
    const key = worldKey();
    const location = route();
    const first = await apply(key, location);
    await addEntityAlias(database.db, first.worldId!, first.npcId!, {
      alias: "Unexpected",
    });
    await expect(
      provisionDevFixture(database.db, location, true, key),
    ).rejects.toThrow("conflicts");
    expect(await dbCounts(first.worldId!)).toMatchObject({
      entities: 3,
      contexts: 1,
      routes: 1,
    });
  });

  it("rejects untrusted in-scene intake with zero interactions or deliveries", async () => {
    const key = worldKey();
    const location = route();
    const first = await apply(key, location);
    const intake = createDiscordIntake(createDiscordPersistence(database.db));
    const botId = "1234567890123456789";
    const message = {
      sourceMessageId: randomUUID(),
      authorId: "1999999999999999999",
      guildId: location.guildId,
      channelId: location.channelId,
      threadId: location.threadId,
      content: "<@" + botId + "> [Sentinel] Check readiness.",
      mentionedUserIds: [botId],
    };
    expect(await intake(message, botId)).toBe("unauthorized");
    expect(
      await intake(
        { ...message, guildId: String(BigInt(location.guildId) + 5n) },
        botId,
      ),
    ).toBe("unmapped");
    expect(
      await intake(
        { ...message, channelId: String(BigInt(location.channelId) + 5n) },
        botId,
      ),
    ).toBe("unmapped");
    expect(
      await intake(
        { ...message, threadId: String(BigInt(location.threadId) + 5n) },
        botId,
      ),
    ).toBe("unmapped");
    expect(await dbCounts(first.worldId!)).toMatchObject({
      identities: 0,
      interactions: 0,
      deliveries: 0,
      presence: 0,
    });
  });

  it("does not change route state when same world key belongs to another owner", async () => {
    const key = worldKey();
    const existing = await createWorld(database.db, {
      key,
      name: "Other",
      systemType: "test",
    });
    createdWorldIds.push(existing.id);
    const location = route();
    await expect(
      provisionDevFixture(database.db, location, true, key),
    ).rejects.toThrow("conflicts");
    const result = await database.pool.query(
      "select id from discord_context_mappings where guild_id=$1 and channel_id=$2",
      [location.guildId, location.channelId],
    );
    expect(result.rows).toHaveLength(0);
  });

  it("rejects NPC state drift even without a version increment", async () => {
    const key = worldKey();
    const location = route();
    const first = await apply(key, location);
    await database.pool.query(
      "update npc_state set physical_state = $2::jsonb where npc_id = $1",
      [first.npcId, JSON.stringify({ summary: "unexpected" })],
    );
    await expect(
      provisionDevFixture(database.db, location, true, key),
    ).rejects.toThrow("conflicts");
    expect(await dbCounts(first.worldId!)).toMatchObject({
      entities: 3,
      contexts: 1,
      routes: 1,
    });
  });

  it("rejects unexpected context metadata or a game profile", async () => {
    const key = worldKey();
    const location = route();
    const first = await apply(key, location);
    await database.pool.query(
      "update interaction_contexts set metadata = $2::jsonb where id = $1",
      [first.contextId, JSON.stringify({ unexpected: true })],
    );
    await expect(
      provisionDevFixture(database.db, location, true, key),
    ).rejects.toThrow("conflicts");
    await database.pool.query(
      "update interaction_contexts set metadata = null where id = $1",
      [first.contextId],
    );
    await database.pool.query(
      "insert into npc_game_profiles (npc_id, game_system, stat_depth) values ($1, 'test', 0)",
      [first.npcId],
    );
    await expect(
      provisionDevFixture(database.db, location, true, key),
    ).rejects.toThrow("conflicts");
  });

  it("rejects added capabilities and reverted policy history", async () => {
    const key = worldKey();
    const location = route();
    const first = await apply(key, location);
    await database.pool.query(
      "insert into npc_capabilities (npc_id, capability_key, level, source, confidence) values ($1, 'unexpected', 'basic', 'manual', 0.5)",
      [first.npcId],
    );
    await expect(
      provisionDevFixture(database.db, location, true, key),
    ).rejects.toThrow("conflicts");
    await database.pool.query(
      "delete from npc_capabilities where npc_id = $1",
      [first.npcId],
    );
    await database.pool.query(
      "insert into context_intake_policy_audit (id, world_id, context_id, previous_policy, target_policy) values ($1, $2, $3, 'disabled', 'mapped_players')",
      [randomUUID(), first.worldId, first.contextId],
    );
    await expect(
      provisionDevFixture(database.db, location, true, key),
    ).rejects.toThrow("conflicts");
  });
});

describe("Step 10 offline Discord thread -> authorized NPC interaction", () => {
  it("enforces default deny, mapped-player authorization, idempotency and policy revocation without outbound", async () => {
    // IMPORTANT: Unique synthetic world/route, never the persistent owner's
    // lw-dev-gateway-001 fixture or real Discord guild, user or message IDs.
    const key = worldKey();
    const location = route();
    const first = await apply(key, location);
    expect(first.status).toBe("created");
    expect(first.worldId).toBeDefined();
    expect(first.contextId).toBeDefined();
    expect(first.npcId).toBeDefined();

    const worldId = first.worldId!;
    const contextId = first.contextId!;
    const npcId = first.npcId!;
    const botId = "1234567890123456789";
    const syntheticAuthorId = "1999999999999999999";
    const message = {
      sourceMessageId: randomUUID(),
      authorId: syntheticAuthorId,
      guildId: location.guildId,
      channelId: location.channelId,
      threadId: location.threadId,
      content: "<@" + botId + "> [Sentinel] Report readiness.",
      mentionedUserIds: [botId],
    };
    const intake = createDiscordIntake(createDiscordPersistence(database.db));
    const run = (input = message) => intake(input, botId);

    // A valid alias and route alone never authorize the request.
    expect(await run()).toBe("unauthorized");
    expect(await dbCounts(worldId)).toMatchObject({
      identities: 0,
      interactions: 0,
      deliveries: 0,
      presence: 0,
    });

    const player = await database.pool.query<{ id: string }>(
      "select id from entities where world_id=$1 and entity_type='player_character'",
      [worldId],
    );
    expect(player.rows).toHaveLength(1);
    const playerId = player.rows[0]!.id;
    await mapDiscordUserToEntity(database.db, worldId, {
      discordUserId: syntheticAuthorId,
      entityId: playerId,
      mappingType: "player_character",
    });

    // Mapping an identity does not override the disabled scene policy.
    expect(await run()).toBe("unauthorized");
    expect(await dbCounts(worldId)).toMatchObject({
      identities: 1,
      interactions: 0,
      deliveries: 0,
      presence: 0,
    });

    const approved = await runContextPolicyCommand([
      "--world",
      worldId,
      "--context",
      contextId,
      "--policy",
      "mapped_players",
    ]);
    expect(approved).toMatchObject({
      worldId,
      contextId,
      previousPolicy: "disabled",
      policy: "mapped_players",
    });

    expect(await run()).toBe("accepted");
    expect(await run()).toBe("duplicate");

    const stored = await database.pool.query(
      "select world_id, context_id, npc_id, speaker_entity_id, " +
        "source_provider, source_message_id, source_guild_id, " +
        "source_channel_id, source_thread_id, source_mapping_id, " +
        "status, communication_mode, response_text, response_claim_id " +
        "from interactions where world_id=$1",
      [worldId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      world_id: worldId,
      context_id: contextId,
      npc_id: npcId,
      speaker_entity_id: playerId,
      source_provider: "discord",
      source_message_id: message.sourceMessageId,
      source_guild_id: location.guildId,
      source_channel_id: location.channelId,
      source_thread_id: location.threadId,
      status: "received",
      communication_mode: "unknown",
      response_text: null,
      response_claim_id: null,
    });
    expect(stored.rows[0].source_mapping_id).toBeTruthy();
    expect(await dbCounts(worldId)).toMatchObject({
      identities: 1,
      interactions: 1,
      deliveries: 0,
      presence: 0,
    });

    // Reject retargeting, wrong thread, and the absence of an explicit alias.
    expect(
      await run({
        ...message,
        content: "<@" + botId + "> [Sentinel] Different request.",
      }),
    ).toBe("event_conflict");
    expect(
      await run({
        ...message,
        sourceMessageId: randomUUID(),
        threadId: String(BigInt(location.threadId) + 10n),
      }),
    ).toBe("unmapped");
    expect(
      await run({
        ...message,
        sourceMessageId: randomUUID(),
        content: "<@" + botId + "> Hello.",
      }),
    ).toBe("invalid_trigger");

    const revoked = await runContextPolicyCommand([
      "--world",
      worldId,
      "--context",
      contextId,
      "--policy",
      "disabled",
    ]);
    expect(revoked).toMatchObject({
      previousPolicy: "mapped_players",
      policy: "disabled",
    });
    expect(await run({ ...message, sourceMessageId: randomUUID() })).toBe(
      "unauthorized",
    );
    expect(await dbCounts(worldId)).toMatchObject({
      identities: 1,
      interactions: 1,
      deliveries: 0,
      presence: 0,
    });

    const audit = await database.pool.query(
      "select previous_policy, target_policy from context_intake_policy_audit " +
        "where world_id=$1 order by created_at, id",
      [worldId],
    );
    expect(audit.rows).toHaveLength(2);
    expect(
      audit.rows.map((row) => [row.previous_policy, row.target_policy]),
    ).toEqual([
      ["disabled", "mapped_players"],
      ["mapped_players", "disabled"],
    ]);
  });
});

describe("Step 11 strict fixture coexistence across independent DEV parents", () => {
  it("preserves the pristine original when a second pilot world uses another parent", async () => {
    const originalKey = worldKey();
    const pilotKey = worldKey();
    const original = route();
    const pilot = {
      guildId: original.guildId,
      channelId: String(BigInt(original.channelId) + 100n),
      threadId: String(BigInt(original.threadId) + 101n),
    };

    const base = await apply(originalKey, original);
    const baseline = await dbCounts(base.worldId!);
    expect(baseline).toMatchObject({
      identities: 0,
      interactions: 0,
      deliveries: 0,
      presence: 0,
    });
    const second = await apply(pilotKey, pilot);
    expect(second.status).toBe("created");
    expect(second.worldId).not.toBe(base.worldId);
    expect(second.contextId).not.toBe(base.contextId);
    expect(second.npcId).not.toBe(base.npcId);

    expect(
      await provisionDevFixture(database.db, original, false, originalKey),
    ).toEqual({ ...base, status: "already_present" });
    expect(
      await provisionDevFixture(database.db, pilot, false, pilotKey),
    ).toEqual({ ...second, status: "already_present" });
    expect(await dbCounts(base.worldId!)).toEqual(baseline);
    expect(await dbCounts(second.worldId!)).toMatchObject(baseline);

    // A second thread under the original parent would break its pristine
    // route invariant, so Step 11 must use a new parent, not only a new thread.
    const overlapping = {
      guildId: original.guildId,
      channelId: original.channelId,
      threadId: String(BigInt(original.threadId) + 200n),
    };
    await expect(
      provisionDevFixture(database.db, overlapping, true, worldKey()),
    ).rejects.toThrow("conflicts");
    expect(
      await provisionDevFixture(database.db, original, false, originalKey),
    ).toEqual({ ...base, status: "already_present" });
  });
});

describe("Step 12 reversible pilot player enrollment (offline PostgreSQL)", () => {
  it("enrolls only in a separate default-deny pilot, is idempotent, and revokes without touching the pristine baseline", async () => {
    const baseKey = worldKey();
    const pilotKey = worldKey();
    const original = route();
    const pilotRoute = {
      guildId: original.guildId,
      channelId: String(BigInt(original.channelId) + 100n),
      threadId: String(BigInt(original.threadId) + 101n),
    };
    const base = await apply(baseKey, original);
    const pilot = await apply(pilotKey, pilotRoute);
    const userId = "1888888888888888888";
    const request = { worldKey: pilotKey, route: pilotRoute, userId };
    const run = (mode: "preview" | "enroll" | "revoke") =>
      reconcilePilotPlayer(database.db, { ...request, mode });

    const originalCounts = await dbCounts(base.worldId!);
    expect(await run("preview")).toMatchObject({
      event: "pilot_player_preview",
      worldId: pilot.worldId,
      contextId: pilot.contextId,
      identityStatus: "absent",
      policy: "disabled",
    });
    expect(await dbCounts(pilot.worldId!)).toMatchObject({
      identities: 0,
      interactions: 0,
      deliveries: 0,
      presence: 0,
    });

    const enrolled = await run("enroll");
    expect(enrolled).toMatchObject({
      event: "pilot_player_enrolled",
      worldId: pilot.worldId,
      policy: "disabled",
    });
    expect(await run("enroll")).toMatchObject({
      event: "pilot_player_already_enrolled",
    });
    expect(await run("preview")).toMatchObject({
      identityStatus: "active",
      policy: "disabled",
    });
    expect(await dbCounts(pilot.worldId!)).toMatchObject({
      identities: 1,
      interactions: 0,
      deliveries: 0,
      presence: 0,
    });

    const incoming = {
      sourceMessageId: randomUUID(),
      authorId: userId,
      guildId: pilotRoute.guildId,
      channelId: pilotRoute.channelId,
      threadId: pilotRoute.threadId,
      content: "<@1234567890123456789> [Sentinel] Hello.",
      mentionedUserIds: ["1234567890123456789"],
    };
    const intake = createDiscordIntake(createDiscordPersistence(database.db));
    expect(await intake(incoming, "1234567890123456789")).toBe("unauthorized");
    expect(await dbCounts(pilot.worldId!)).toMatchObject({
      interactions: 0,
      deliveries: 0,
    });

    expect(await run("revoke")).toMatchObject({
      event: "pilot_player_revoked",
      policy: "disabled",
    });
    expect(await run("revoke")).toMatchObject({
      event: "pilot_player_already_revoked",
    });
    expect(await run("preview")).toMatchObject({
      identityStatus: "inactive",
    });
    await expect(run("enroll")).rejects.toThrow("manual review");
    expect(await dbCounts(pilot.worldId!)).toMatchObject({
      identities: 1,
      interactions: 0,
      deliveries: 0,
    });

    expect(
      await provisionDevFixture(database.db, original, false, baseKey),
    ).toEqual({ ...base, status: "already_present" });
    expect(await dbCounts(base.worldId!)).toEqual(originalCounts);
  });

  it("rejects wrong route or unrecognized identity without changing a pristine world", async () => {
    const key = worldKey();
    const location = route();
    const pilot = await apply(key, location);
    const userId = "1888888888888888888";
    const request = {
      worldKey: key,
      route: location,
      userId,
      mode: "enroll" as const,
    };
    await expect(
      reconcilePilotPlayer(database.db, {
        ...request,
        route: {
          ...location,
          threadId: String(BigInt(location.threadId) + 5n),
        },
      }),
    ).rejects.toThrow("scene");
    expect(await dbCounts(pilot.worldId!)).toMatchObject({
      identities: 0,
      interactions: 0,
      deliveries: 0,
    });
    expect(
      await reconcilePilotPlayer(database.db, {
        ...request,
        mode: "preview",
      }),
    ).toMatchObject({
      identityStatus: "absent",
    });
  });
});
