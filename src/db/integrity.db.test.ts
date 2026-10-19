import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient } from "./client.js";
import { createDiscordPersistence } from "../adapters/discord/persistence.js";
import {
  createDiscordIntake,
  type IncomingMessage,
} from "../intake/discord-intake.js";
import { getNpcWithState } from "../domains/npc/npc.repository.js";
import { completeInteraction } from "../domains/interaction/interaction.repository.js";

const incoming: IncomingMessage = {
  sourceMessageId: "discord-event",
  authorId: "unknown-user",
  guildId: "integrity-guild",
  channelId: "integrity-channel",
  threadId: null,
  content: "Please check the manifest.",
  mentionedUserIds: [],
};
import { discordContextMappings } from "./schema/discord-context-mappings.js";
import { discordIdentities } from "./schema/discord-identities.js";
import { interactionContexts } from "./schema/interaction-contexts.js";
import { interactions } from "./schema/interactions.js";
import { memorySources } from "./schema/memory-sources.js";
import { relationshipEvents } from "./schema/relationship-events.js";
import { tasks } from "./schema/tasks.js";
import { createWorld } from "../domains/world/world.repository.js";
import { createEntity } from "../domains/entity/entity.repository.js";
import { createNpc } from "../domains/npc/npc.repository.js";
import { peloNpcFixture } from "../domains/npc/npc.test-fixture.js";
import {
  createInteraction,
  createInteractionContext,
  recordInteractionResponse,
} from "../domains/interaction/interaction.repository.js";
import {
  DiscordMappingConflictError,
  deactivateDiscordUserMapping,
  getContextByDiscordLocation,
  getNpcPrimaryContext,
  listDiscordUserMappings,
  mapDiscordContext,
  mapDiscordUserToEntity,
  setNpcPrimaryContext,
  setPrimaryDiscordEntity,
} from "../domains/discord-mapping/discord-mapping.repository.js";
import {
  addMemorySource,
  createMemory,
} from "../domains/memory/memory.repository.js";
import { peloMemoryFixtures } from "../domains/memory/memory.test-fixture.js";
import {
  applyRelationshipEvent,
  createRelationship,
} from "../domains/relationship/relationship.repository.js";

const database = createDatabaseClient();
const worldIds: string[] = [];
let world: string, foreignWorld: string;
let npc: string, otherNpc: string, foreignNpc: string;
let first: string, second: string, foreignEntity: string;
let channel: string, thread: string, foreignContext: string;
const location = {
  guildId: "integrity-guild",
  channelId: "integrity-channel",
  mappingType: "scene" as const,
};
const identity = {
  discordUserId: "integrity-user",
  mappingType: "player_character" as const,
};

beforeEach(async () => {
  const a = await createWorld(database.db, {
    key: randomUUID(),
    name: "Integrity A",
    systemType: "test",
  });
  worldIds.push(a.id);
  world = a.id;
  const b = await createWorld(database.db, {
    key: randomUUID(),
    name: "Integrity B",
    systemType: "test",
  });
  worldIds.push(b.id);
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
  first = (
    await createEntity(database.db, world, {
      entityType: "player_character",
      canonicalName: "First",
    })
  ).id;
  second = (
    await createEntity(database.db, world, {
      entityType: "player_character",
      canonicalName: "Second",
    })
  ).id;
  foreignEntity = (
    await createEntity(database.db, foreignWorld, {
      entityType: "player_character",
      canonicalName: "Foreign",
    })
  ).id;
  channel = (
    await createInteractionContext(database.db, world, { contextType: "scene" })
  ).id;
  thread = (
    await createInteractionContext(database.db, world, { contextType: "scene" })
  ).id;
  foreignContext = (
    await createInteractionContext(database.db, foreignWorld, {
      contextType: "scene",
    })
  ).id;
});

afterEach(async () => {
  // Delete only fixtures in UUID worlds created by this suite, in FK order.
  for (const id of worldIds) {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      for (const query of [
        "delete from memory_sources where memory_id in (select id from npc_memories where world_id = $1)",
        "delete from relationship_events where relationship_id in (select id from relationships where world_id = $1)",
        "delete from npc_memories where world_id = $1",
        "delete from relationships where world_id = $1",
        "delete from discord_context_mappings where world_id = $1",
        "delete from discord_identities where world_id = $1",
        "delete from tasks where world_id = $1",
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
  worldIds.length = 0;
});

afterAll(async () => database.close());

async function interaction(worldId = world, npcId = npc, contextId = channel) {
  return (await createInteraction(database.db, worldId, npcId, {
    contextId,
    interactionType: "social",
    communicationMode: "remote",
    requestText: "Audit provenance",
    sourceMessageId: "000123:opaque-source",
  }))!;
}

describe("M2.3.1 mapping constraints", () => {
  it("rejects duplicate channel locations with a domain error and raw SQL constraint", async () => {
    await mapDiscordContext(database.db, world, {
      ...location,
      contextId: channel,
    });
    await expect(
      mapDiscordContext(database.db, world, { ...location, contextId: thread }),
    ).rejects.toBeInstanceOf(DiscordMappingConflictError);
    await expect(
      database.db.insert(discordContextMappings).values({
        id: randomUUID(),
        worldId: world,
        ...location,
        contextId: thread,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("preserves distinct threads, exact priority, and unknown-thread channel fallback", async () => {
    await mapDiscordContext(database.db, world, {
      ...location,
      contextId: channel,
    });
    await mapDiscordContext(database.db, world, {
      ...location,
      threadId: "one",
      contextId: thread,
    });
    await mapDiscordContext(database.db, world, {
      ...location,
      threadId: "two",
      contextId: thread,
    });
    await expect(
      getContextByDiscordLocation(
        database.db,
        world,
        location.guildId,
        location.channelId,
        "one",
      ),
    ).resolves.toMatchObject({ id: thread });
    await expect(
      getContextByDiscordLocation(
        database.db,
        world,
        location.guildId,
        location.channelId,
        "two",
      ),
    ).resolves.toMatchObject({ id: thread });
    await expect(
      getContextByDiscordLocation(
        database.db,
        world,
        location.guildId,
        location.channelId,
        "missing",
      ),
    ).resolves.toMatchObject({ id: channel });
    await expect(
      mapDiscordContext(database.db, world, {
        ...location,
        threadId: "one",
        contextId: channel,
      }),
    ).rejects.toBeInstanceOf(DiscordMappingConflictError);
  });

  it("allows exactly one winner in concurrent channel mapping creation", async () => {
    const results = await Promise.allSettled(
      [channel, thread].map((contextId) =>
        mapDiscordContext(database.db, world, { ...location, contextId }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      DiscordMappingConflictError,
    );
  });

  it("keeps identical Discord locations and primary users isolated across worlds", async () => {
    await mapDiscordContext(database.db, world, {
      ...location,
      contextId: channel,
    });
    await mapDiscordContext(database.db, foreignWorld, {
      ...location,
      contextId: foreignContext,
    });
    await mapDiscordUserToEntity(database.db, world, {
      ...identity,
      entityId: first,
      isPrimary: true,
    });
    await mapDiscordUserToEntity(database.db, foreignWorld, {
      ...identity,
      entityId: foreignEntity,
      isPrimary: true,
    });
    await expect(
      getContextByDiscordLocation(
        database.db,
        foreignWorld,
        location.guildId,
        location.channelId,
      ),
    ).resolves.toMatchObject({ id: foreignContext });
    await expect(
      listDiscordUserMappings(
        database.db,
        foreignWorld,
        identity.discordUserId,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ entityId: foreignEntity, isPrimary: true }),
    ]);
  });

  it("rejects inactive primary creation and selection without clearing the current primary", async () => {
    await mapDiscordUserToEntity(database.db, world, {
      ...identity,
      entityId: first,
      isPrimary: true,
    });
    await mapDiscordUserToEntity(database.db, world, {
      ...identity,
      entityId: second,
      status: "inactive",
    });
    await expect(
      setPrimaryDiscordEntity(
        database.db,
        world,
        identity.discordUserId,
        second,
      ),
    ).rejects.toThrow("Inactive");
    await expect(
      mapDiscordUserToEntity(database.db, world, {
        ...identity,
        entityId: foreignEntity,
        status: "inactive",
        isPrimary: true,
      }),
    ).rejects.toThrow("Inactive");
    expect(
      (
        await listDiscordUserMappings(
          database.db,
          world,
          identity.discordUserId,
        )
      ).filter((row) => row.isPrimary),
    ).toMatchObject([{ entityId: first }]);
  });

  it("enforces primary uniqueness and active status even for direct database writes", async () => {
    await mapDiscordUserToEntity(database.db, world, {
      ...identity,
      entityId: first,
      isPrimary: true,
    });
    await expect(
      database.db.insert(discordIdentities).values({
        id: randomUUID(),
        worldId: world,
        ...identity,
        entityId: second,
        isPrimary: true,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(
      database.db.insert(discordIdentities).values({
        id: randomUUID(),
        worldId: world,
        ...identity,
        entityId: second,
        isPrimary: true,
        status: "inactive",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("deactivates a primary without arbitrarily selecting another character", async () => {
    const primary = await mapDiscordUserToEntity(database.db, world, {
      ...identity,
      entityId: first,
      isPrimary: true,
    });
    await mapDiscordUserToEntity(database.db, world, {
      ...identity,
      entityId: second,
    });
    await expect(
      deactivateDiscordUserMapping(database.db, foreignWorld, primary.id),
    ).resolves.toBeNull();
    await expect(
      deactivateDiscordUserMapping(database.db, world, primary.id),
    ).resolves.toMatchObject({ status: "inactive", isPrimary: false });
    expect(
      (
        await listDiscordUserMappings(
          database.db,
          world,
          identity.discordUserId,
        )
      ).filter((row) => row.isPrimary),
    ).toHaveLength(0);
  });

  it("serializes concurrent first-primary creation and primary replacement", async () => {
    await Promise.all(
      [first, second].map((entityId) =>
        mapDiscordUserToEntity(database.db, world, {
          ...identity,
          entityId,
          isPrimary: true,
        }),
      ),
    );
    await Promise.all(
      [first, second, first, second].map((entityId) =>
        setPrimaryDiscordEntity(
          database.db,
          world,
          identity.discordUserId,
          entityId,
        ),
      ),
    );
    const rows = await listDiscordUserMappings(
      database.db,
      world,
      identity.discordUserId,
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.filter((row) => row.isPrimary && row.status === "active"),
    ).toHaveLength(1);
  });

  it("safely serializes deactivation against primary selection", async () => {
    const mapping = await mapDiscordUserToEntity(database.db, world, {
      ...identity,
      entityId: first,
      isPrimary: true,
    });
    const results = await Promise.allSettled([
      setPrimaryDiscordEntity(
        database.db,
        world,
        identity.discordUserId,
        first,
      ),
      deactivateDiscordUserMapping(database.db, world, mapping.id),
    ]);
    expect(results[1]?.status).toBe("fulfilled");
    await expect(
      listDiscordUserMappings(database.db, world, identity.discordUserId),
    ).resolves.toEqual([
      expect.objectContaining({ status: "inactive", isPrimary: false }),
    ]);
  });

  it("rejects ambiguous identity types rather than choosing an arbitrary mapping", async () => {
    await mapDiscordUserToEntity(database.db, world, {
      ...identity,
      entityId: first,
    });
    await mapDiscordUserToEntity(database.db, world, {
      ...identity,
      mappingType: "observer",
      entityId: first,
    });
    await expect(
      setPrimaryDiscordEntity(
        database.db,
        world,
        identity.discordUserId,
        first,
      ),
    ).rejects.toBeInstanceOf(DiscordMappingConflictError);
  });

  it("serializes NPC primary routing and enforces one active primary in SQL", async () => {
    await mapDiscordContext(database.db, world, {
      ...location,
      contextId: channel,
    });
    await mapDiscordContext(database.db, world, {
      ...location,
      threadId: "thread",
      contextId: thread,
    });
    await Promise.all(
      [channel, thread].map((contextId) =>
        setNpcPrimaryContext(database.db, world, npc, contextId),
      ),
    );
    const primary = await getNpcPrimaryContext(database.db, world, npc);
    expect([channel, thread]).toContain(primary?.id);
    const rows = await database.db
      .select()
      .from(discordContextMappings)
      .where(
        and(
          eq(discordContextMappings.worldId, world),
          eq(discordContextMappings.npcId, npc),
          eq(discordContextMappings.status, "active"),
        ),
      );
    expect(rows).toHaveLength(1);
    await expect(
      database.db.insert(discordContextMappings).values({
        id: randomUUID(),
        worldId: world,
        ...location,
        channelId: "another",
        contextId: channel,
        npcId: npc,
        mappingType: "npc_primary",
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });
});

describe("M2.4 durable Discord intake", () => {
  it("deduplicates concurrent events and preserves the original interaction and terminal lifecycle", async () => {
    const input = {
      contextId: channel,
      interactionType: "social" as const,
      communicationMode: "unknown" as const,
      requestText: "Original",
      sourceProvider: "discord",
      sourceMessageId: incoming.sourceMessageId,
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        createInteraction(database.db, world, npc, input),
      ),
    );
    expect(new Set(results.map((row) => row!.id)).size).toBe(1);
    const original = results[0]!;
    expect(original).toMatchObject({
      status: "received",
      responseText: null,
      sourceProvider: "discord",
    });
    await recordInteractionResponse(database.db, world, npc, original.id, {
      responseText: "Recorded by a later processor",
    });
    await completeInteraction(database.db, world, npc, original.id);
    const retried = await createInteraction(database.db, world, npc, {
      ...input,
      contextId: thread,
      requestText: "Replacement attempt",
    });
    expect(retried).toMatchObject({
      id: original.id,
      requestText: "Original",
      contextId: channel,
      traceId: original.traceId,
      status: "completed",
    });
    await expect(
      database.db.insert(interactions).values({
        id: randomUUID(),
        worldId: world,
        npcId: npc,
        traceId: randomUUID(),
        ...input,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("allows distinct targets, worlds, providers and legacy unqualified references", async () => {
    const base = {
      interactionType: "social" as const,
      communicationMode: "unknown" as const,
      requestText: "test",
      sourceMessageId: incoming.sourceMessageId,
      sourceProvider: "discord",
    };
    const rows = await Promise.all([
      createInteraction(database.db, world, npc, {
        ...base,
        contextId: channel,
      }),
      createInteraction(database.db, world, otherNpc, {
        ...base,
        contextId: channel,
      }),
      createInteraction(database.db, foreignWorld, foreignNpc, {
        ...base,
        contextId: foreignContext,
      }),
      createInteraction(database.db, world, npc, {
        ...base,
        contextId: channel,
        sourceProvider: "other",
      }),
      createInteraction(database.db, world, npc, {
        ...base,
        contextId: channel,
        sourceProvider: null,
      }),
      createInteraction(database.db, world, npc, {
        ...base,
        contextId: channel,
        sourceProvider: null,
      }),
    ]);
    expect(new Set(rows.map((row) => row!.id)).size).toBe(6);
    await expect(
      database.db.insert(interactions).values({
        id: randomUUID(),
        worldId: world,
        npcId: npc,
        contextId: channel,
        traceId: randomUUID(),
        interactionType: "social",
        communicationMode: "unknown",
        requestText: "test",
        sourceProvider: "discord",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("persists multiple mentioned NPCs atomically through the real intake during concurrent redelivery", async () => {
    await mapDiscordContext(database.db, world, {
      ...location,
      contextId: channel,
    });
    for (const [discordUserId, entityId] of [
      ["123", npc],
      ["456", otherNpc],
    ])
      await mapDiscordUserToEntity(database.db, world, {
        discordUserId,
        entityId,
        mappingType: "npc_operator",
      });
    const intake = createDiscordIntake(createDiscordPersistence(database.db));
    const message = {
      ...incoming,
      content: "<@123> <@456> Please check.",
      mentionedUserIds: ["123", "456"],
    };
    expect(
      await Promise.all(Array.from({ length: 4 }, () => intake(message))),
    ).toEqual(["accepted", "accepted", "accepted", "accepted"]);
    const rows = await database.db
      .select()
      .from(interactions)
      .where(eq(interactions.worldId, world));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.npcId))).toEqual(
      new Set([npc, otherNpc]),
    );
    expect(new Set(rows.map((row) => row.traceId)).size).toBe(1);
    for (const row of rows)
      expect(row).toMatchObject({
        sourceProvider: "discord",
        sourceMessageId: incoming.sourceMessageId,
        contextId: channel,
        speakerEntityId: null,
        status: "received",
        communicationMode: "unknown",
        interactionType: "social",
        responseText: null,
      });
  });

  it("uses exact thread context before fallback, preserving NPC state and other domain data", async () => {
    await mapDiscordContext(database.db, world, {
      ...location,
      contextId: channel,
    });
    await setNpcPrimaryContext(database.db, world, npc, channel);
    await mapDiscordContext(database.db, world, {
      ...location,
      contextId: thread,
      threadId: "known-thread",
    });
    await setNpcPrimaryContext(database.db, world, otherNpc, thread);
    const before = await Promise.all([
      getNpcWithState(database.db, world, npc),
      getNpcWithState(database.db, world, otherNpc),
    ]);
    const intake = createDiscordIntake(createDiscordPersistence(database.db));
    expect(
      await intake({
        ...incoming,
        sourceMessageId: "thread-event",
        threadId: "known-thread",
      }),
    ).toBe("accepted");
    expect(
      await intake({
        ...incoming,
        sourceMessageId: "fallback-event",
        threadId: "unknown-thread",
      }),
    ).toBe("accepted");
    const rows = await database.db
      .select()
      .from(interactions)
      .where(eq(interactions.worldId, world));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceMessageId: "thread-event",
          contextId: thread,
          npcId: otherNpc,
        }),
        expect.objectContaining({
          sourceMessageId: "fallback-event",
          contextId: channel,
          npcId: npc,
        }),
      ]),
    );
    expect(
      await Promise.all([
        getNpcWithState(database.db, world, npc),
        getNpcWithState(database.db, world, otherNpc),
      ]),
    ).toEqual(before);
    for (const table of [
      "npc_memories",
      "npc_knowledge",
      "relationships",
      "tasks",
    ]) {
      const result = await database.pool.query(
        `select count(*)::int as count from ${table} where world_id = $1`,
        [world],
      );
      expect(result.rows).toEqual([{ count: 0 }]);
    }
  });

  it("rejects unmapped and cross-world ambiguous locations", async () => {
    const intake = createDiscordIntake(createDiscordPersistence(database.db));
    expect(await intake(incoming)).toBe("unmapped");
    await mapDiscordContext(database.db, world, {
      ...location,
      contextId: channel,
    });
    await setNpcPrimaryContext(database.db, world, npc, channel);
    expect(await intake({ ...incoming, guildId: "unmapped-guild" })).toBe(
      "unmapped",
    );
    expect(await intake({ ...incoming, channelId: "unmapped-channel" })).toBe(
      "unmapped",
    );
    await mapDiscordContext(database.db, foreignWorld, {
      ...location,
      contextId: foreignContext,
    });
    expect(await intake(incoming)).toBe("ambiguous_world");
    expect(
      await database.db
        .select()
        .from(interactions)
        .where(eq(interactions.worldId, world)),
    ).toHaveLength(0);
  });

  it("rejects ambiguous speakers and resolves explicit primaries through real mappings", async () => {
    await mapDiscordContext(database.db, world, {
      ...location,
      contextId: channel,
    });
    await setNpcPrimaryContext(database.db, world, npc, channel);
    for (const entityId of [first, second])
      await mapDiscordUserToEntity(database.db, world, {
        ...identity,
        entityId,
      });
    const intake = createDiscordIntake(createDiscordPersistence(database.db));
    const message = { ...incoming, authorId: identity.discordUserId };
    expect(await intake(message)).toBe("ambiguous_speaker");
    await setPrimaryDiscordEntity(
      database.db,
      world,
      identity.discordUserId,
      second,
    );
    expect(await intake(message)).toBe("accepted");
    const rows = await database.db
      .select()
      .from(interactions)
      .where(eq(interactions.worldId, world));
    expect(rows).toMatchObject([{ speakerEntityId: second }]);
  });

  it("rolls back all targets if one target becomes unavailable", async () => {
    const persistence = createDiscordPersistence(database.db);
    await expect(
      persistence.persist({
        worldId: world,
        contextId: channel,
        speakerEntityId: null,
        npcIds: [npc, randomUUID()],
        message: incoming,
        traceId: randomUUID(),
      }),
    ).rejects.toThrow("no longer available");
    expect(
      await database.db
        .select()
        .from(interactions)
        .where(eq(interactions.worldId, world)),
    ).toHaveLength(0);
  });
});

describe("M2.3.1 ownership and provenance", () => {
  it.each(["location", "primary", "world"] as const)(
    "aborts migration preflight on legacy %s conflicts and restores constraints on rollback",
    async (kind) => {
      const migration = readFileSync(
        new URL("./migrations/0008_mapping_integrity.sql", import.meta.url),
        "utf8",
      );
      const preflight = migration.slice(
        migration.indexOf("DO $$"),
        migration.indexOf("END $$;") + "END $$;".length,
      );
      await expect(
        database.db.transaction(async (transaction) => {
          if (kind === "location") {
            await transaction.execute(
              sql`alter table discord_context_mappings drop constraint discord_context_mappings_location_unique`,
            );
            await transaction.insert(discordContextMappings).values(
              [channel, thread].map((contextId) => ({
                id: randomUUID(),
                worldId: world,
                ...location,
                contextId,
              })),
            );
          } else if (kind === "primary") {
            await transaction.execute(
              sql`alter table discord_identities drop constraint discord_identity_primary_active`,
            );
            await transaction.insert(discordIdentities).values({
              id: randomUUID(),
              worldId: world,
              ...identity,
              entityId: first,
              status: "inactive",
              isPrimary: true,
            });
          } else {
            await transaction.execute(
              sql`alter table discord_identities drop constraint discord_identity_world_fk`,
            );
            await transaction.insert(discordIdentities).values({
              id: randomUUID(),
              worldId: world,
              ...identity,
              entityId: foreignEntity,
            });
          }
          await transaction.execute(sql.raw(preflight));
        }),
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining("M2.3.1 preflight:") },
      });
      // No invalid fixtures survive, and the transaction restores the dropped constraint.
      expect(
        await database.db
          .select()
          .from(discordIdentities)
          .where(eq(discordIdentities.worldId, world)),
      ).toHaveLength(0);
      expect(
        await database.db
          .select()
          .from(discordContextMappings)
          .where(eq(discordContextMappings.worldId, world)),
      ).toHaveLength(0);
      const constraint =
        kind === "location"
          ? "discord_context_mappings_location_unique"
          : kind === "primary"
            ? "discord_identity_primary_active"
            : "discord_identity_world_fk";
      const result = await database.pool.query(
        "select convalidated from pg_constraint where conname = $1",
        [constraint],
      );
      expect(result.rows).toEqual([{ convalidated: true }]);
    },
  );
  it("enforces all affected composite world foreign keys on direct inserts", async () => {
    const origin = await interaction(foreignWorld, foreignNpc, foreignContext);
    const baseInteraction = {
      id: randomUUID(),
      worldId: world,
      npcId: npc,
      contextId: channel,
      interactionType: "social" as const,
      communicationMode: "remote" as const,
      requestText: "test",
      traceId: randomUUID(),
    };
    const writes = [
      () =>
        database.db.insert(discordIdentities).values({
          id: randomUUID(),
          worldId: world,
          ...identity,
          entityId: foreignEntity,
        }),
      () =>
        database.db.insert(discordContextMappings).values({
          id: randomUUID(),
          worldId: world,
          ...location,
          contextId: foreignContext,
        }),
      () =>
        database.db.insert(discordContextMappings).values({
          id: randomUUID(),
          worldId: world,
          ...location,
          contextId: channel,
          npcId: foreignNpc,
        }),
      () =>
        database.db.insert(interactionContexts).values({
          id: randomUUID(),
          worldId: world,
          contextType: "scene",
          linkedLocationEntityId: foreignEntity,
        }),
      () =>
        database.db
          .insert(interactions)
          .values({ ...baseInteraction, contextId: foreignContext }),
      () =>
        database.db
          .insert(interactions)
          .values({ ...baseInteraction, npcId: foreignNpc }),
      () =>
        database.db
          .insert(interactions)
          .values({ ...baseInteraction, speakerEntityId: foreignEntity }),
      ...[
        { assigneeEntityId: foreignEntity },
        { requesterEntityId: foreignEntity },
        { originInteractionId: origin.id },
        { originContextId: foreignContext },
      ].map(
        (overrides) => () =>
          database.db.insert(tasks).values({
            id: randomUUID(),
            worldId: world,
            assigneeEntityId: first,
            objective: "test",
            ...overrides,
          }),
      ),
    ];
    for (const write of writes)
      await expect(write()).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects source/response reuse and preserves lifecycle plus immutable responses", async () => {
    const source = await interaction();
    await expect(
      recordInteractionResponse(database.db, world, npc, source.id, {
        responseText: "ok",
        responseMessageId: source.sourceMessageId,
      }),
    ).rejects.toThrow("must differ");
    await expect(
      recordInteractionResponse(database.db, foreignWorld, npc, source.id, {
        responseText: "ok",
      }),
    ).resolves.toBeNull();
    await expect(
      recordInteractionResponse(database.db, world, otherNpc, source.id, {
        responseText: "ok",
      }),
    ).resolves.toBeNull();
    await expect(
      recordInteractionResponse(database.db, world, npc, source.id, {
        responseText: "ok",
        responseMessageId: "000456:opaque-response",
      }),
    ).resolves.toMatchObject({
      status: "responded",
      responseMessageId: "000456:opaque-response",
    });
    await expect(
      recordInteractionResponse(database.db, world, npc, source.id, {
        responseText: "replacement",
      }),
    ).rejects.toThrow("already been recorded");
  });

  it("validates interaction provenance existence, world and NPC for memories and relationship events", async () => {
    const own = await interaction();
    const other = await interaction(world, otherNpc);
    const foreign = await interaction(foreignWorld, foreignNpc, foreignContext);
    const memory = (await createMemory(
      database.db,
      world,
      npc,
      peloMemoryFixtures[0]!,
    ))!;
    const relationship = await createRelationship(
      database.db,
      world,
      npc,
      first,
      {},
    );
    expect(relationship).not.toBeNull();
    for (const sourceInteractionId of [randomUUID(), other.id, foreign.id]) {
      await expect(
        addMemorySource(database.db, world, npc, memory.id, {
          sourceType: "interaction",
          sourceInteractionId,
        }),
      ).rejects.toThrow("Source interaction");
      await expect(
        applyRelationshipEvent(database.db, world, npc, first, {
          eventType: "interaction",
          delta: { trust: 1 },
          reasonSummary: "test",
          sourceInteractionId,
        }),
      ).rejects.toThrow("Source interaction");
    }
    await expect(
      addMemorySource(database.db, world, npc, memory.id, {
        sourceType: "interaction",
        sourceInteractionId: own.id,
      }),
    ).resolves.toMatchObject({ sourceInteractionId: own.id });
    await expect(
      applyRelationshipEvent(database.db, world, npc, first, {
        eventType: "interaction",
        delta: { trust: 1 },
        reasonSummary: "test",
        sourceInteractionId: own.id,
      }),
    ).resolves.toMatchObject({ event: { sourceInteractionId: own.id } });
    await expect(
      database.db.insert(memorySources).values({
        id: randomUUID(),
        memoryId: memory.id,
        sourceType: "interaction",
        sourceInteractionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(
      database.db.insert(relationshipEvents).values({
        id: randomUUID(),
        relationshipId: relationship!.id,
        eventType: "interaction",
        delta: {},
        reasonSummary: "test",
        sourceInteractionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });
});
