import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createDatabaseClient } from "./client.js";
import { createWorld } from "../domains/world/world.repository.js";
import { addEntityAlias } from "../domains/entity/entity.repository.js";
import { createDiscordPersistence } from "../adapters/discord/persistence.js";
import { createDiscordIntake } from "../intake/discord-intake.js";
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
