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
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getDatabaseConfig } from "./config.js";
import { createDatabaseClient } from "./client.js";
import { createWorld } from "../domains/world/world.repository.js";
import {
  createEntity,
  addEntityAlias,
} from "../domains/entity/entity.repository.js";
import { createNpc, getNpcWithState } from "../domains/npc/npc.repository.js";
import { peloNpcFixture } from "../domains/npc/npc.test-fixture.js";
import {
  createInteractionContext,
  createInteraction,
  getInteraction,
  recordInteractionResponse,
  completeInteraction,
} from "../domains/interaction/interaction.repository.js";
import {
  mapDiscordContext,
  mapDiscordUserToEntity,
  setPrimaryDiscordEntity,
  deactivateDiscordUserMapping,
} from "../domains/discord-mapping/discord-mapping.repository.js";
import { createDiscordPersistence } from "../adapters/discord/persistence.js";
import {
  createDiscordIntake,
  type IncomingMessage,
} from "../intake/discord-intake.js";
import { runContextPolicyCommand } from "../admin/context-intake-policy.js";
import { createNpcResponseOrchestrator } from "../response/orchestrator.js";
import { createResponseStore } from "../response/response.repository.js";
import { createNpcContextBuilder } from "../context/context.repository.js";
import { createTextGenerator } from "../llm/generation.js";
import {
  enabledConfig,
  fakeBudget,
  fakeProvider,
} from "../llm/llm.test-fixture.js";

const database = createDatabaseClient();
const worlds: string[] = [];
let world: string,
  foreignWorld: string,
  npc: string,
  otherNpc: string,
  foreignNpc: string,
  scene: string,
  threadScene: string,
  foreignScene: string,
  pc: string,
  secondPc: string;
let message: IncomingMessage;
const location = {
  guildId: "trigger-guild",
  channelId: "trigger-channel",
  mappingType: "scene" as const,
};
const author = "000sender";
const policy = (
  contextId = scene,
  target = "mapped_players",
  worldId = world,
) =>
  runContextPolicyCommand([
    "--world",
    worldId,
    "--context",
    contextId,
    "--policy",
    target,
  ]);
const run = (incoming = message) =>
  createDiscordIntake(createDiscordPersistence(database.db))(incoming, "123");
const rows = async () =>
  (
    await database.pool.query(
      "select * from interactions where world_id=$1 and source_provider='discord' and source_message_id=$2 order by id",
      [world, message.sourceMessageId],
    )
  ).rows;
beforeEach(async () => {
  world = (
    await createWorld(database.db, {
      key: randomUUID(),
      name: "Trigger fixture",
      systemType: "test",
    })
  ).id;
  worlds.push(world);
  foreignWorld = (
    await createWorld(database.db, {
      key: randomUUID(),
      name: "Foreign trigger fixture",
      systemType: "test",
    })
  ).id;
  worlds.push(foreignWorld);
  const place = await createEntity(database.db, world, {
    entityType: "location",
    canonicalName: "Independent location",
  });
  npc = (
    await createNpc(database.db, world, {
      ...peloNpcFixture,
      initialState: {
        ...peloNpcFixture.initialState,
        currentLocationId: place.id,
        locationCertainty: "certain",
      },
    })
  ).entityId;
  otherNpc = (
    await createNpc(database.db, world, {
      ...peloNpcFixture,
      canonicalName: "Other NPC",
    })
  ).entityId;
  foreignNpc = (await createNpc(database.db, foreignWorld, peloNpcFixture))
    .entityId;
  pc = (
    await createEntity(database.db, world, {
      entityType: "player_character",
      canonicalName: "Speaker",
    })
  ).id;
  secondPc = (
    await createEntity(database.db, world, {
      entityType: "player_character",
      canonicalName: "Second speaker",
    })
  ).id;
  scene = (
    await createInteractionContext(database.db, world, {
      contextType: "scene",
      linkedLocationEntityId: place.id,
    })
  ).id;
  threadScene = (
    await createInteractionContext(database.db, world, { contextType: "scene" })
  ).id;
  foreignScene = (
    await createInteractionContext(database.db, foreignWorld, {
      contextType: "scene",
    })
  ).id;
  await mapDiscordContext(database.db, world, {
    ...location,
    contextId: scene,
  });
  await addEntityAlias(database.db, world, npc, { alias: "Garak" });
  await addEntityAlias(database.db, foreignWorld, foreignNpc, {
    alias: "Garak",
  });
  await addEntityAlias(database.db, foreignWorld, foreignNpc, {
    alias: "Foreign only",
  });
  await mapDiscordUserToEntity(database.db, world, {
    discordUserId: author,
    entityId: pc,
    mappingType: "player_character",
  });
  await policy();
  message = {
    sourceMessageId: randomUUID(),
    authorId: author,
    guildId: location.guildId,
    channelId: location.channelId,
    threadId: null,
    content: "<@123> [Garak] Check the manifest.",
    mentionedUserIds: ["123"],
  };
});
afterEach(async () => {
  for (const id of worlds) {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      for (const query of [
        "delete from interactions where world_id=$1",
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
  worlds.length = 0;
});
afterAll(async () => database.close());

describe("M2.8 explicit authorized Discord intake", () => {
  it("persists exactly one scoped unknown-mode interaction without asserting presence or invoking M2.7", async () => {
    const before = await getNpcWithState(database.db, world, npc);
    expect(await run()).toBe("accepted");
    const [row] = await rows();
    expect(row).toMatchObject({
      world_id: world,
      npc_id: npc,
      context_id: scene,
      speaker_entity_id: pc,
      status: "received",
      interaction_type: "social",
      communication_mode: "unknown",
      request_text: message.content,
      source_provider: "discord",
      source_message_id: message.sourceMessageId,
      response_text: null,
      response_claim_id: null,
    });
    expect(await getNpcWithState(database.db, world, npc)).toEqual(before);
    const provider = fakeProvider(),
      budget = fakeBudget();
    const respond = createNpcResponseOrchestrator({
      read: (s) =>
        getInteraction(database.db, s.worldId, s.npcId, s.interactionId),
      build: createNpcContextBuilder(database.db),
      store: createResponseStore(database.db),
      generate: createTextGenerator(enabledConfig(), provider, budget),
    });
    expect(await respond(world, npc, row.id)).toMatchObject({
      error: "visibility_blocked",
    });
    expect(provider.countInput).not.toHaveBeenCalled();
    expect(provider.generate).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect((await rows())[0]).toEqual(row);
  });
  it("normalizes registered aliases without canonical-name or foreign-world fallback", async () => {
    expect(await run({ ...message, content: "<@!123> [ GARAK ] Hello." })).toBe(
      "accepted",
    );
    expect((await rows())[0].npc_id).toBe(npc);
    expect(
      await run({
        ...message,
        sourceMessageId: randomUUID(),
        content: "<@123> [Foreign only] Hello.",
      }),
    ).toBe("invalid_target");
    expect(
      await run({
        ...message,
        sourceMessageId: randomUUID(),
        content: `<@123> [${peloNpcFixture.canonicalName}] Hello.`,
      }),
    ).toBe("invalid_target");
  });
  it.each(["npc", "inactive_npc", "character"])(
    "fails closed on a same-world alias collision with %s",
    async (kind) => {
      const entity = kind === "character" ? pc : otherNpc;
      if (kind === "inactive_npc")
        await database.pool.query(
          "update npcs set lifecycle_state='dormant' where entity_id=$1",
          [entity],
        );
      await addEntityAlias(database.db, world, entity, { alias: " garak " });
      expect(await run()).toBe("ambiguous_target");
      expect(await rows()).toHaveLength(0);
    },
  );
  it("rejects an alias whose only local match is not an NPC", async () => {
    await addEntityAlias(database.db, world, pc, { alias: "Character" });
    expect(
      await run({ ...message, content: "<@123> [Character] Hello." }),
    ).toBe("invalid_target");
    expect(await rows()).toHaveLength(0);
  });
  it("defaults new contexts to disabled and denies mapped players until explicitly enabled", async () => {
    const result = await database.pool.query(
      "select npc_intake_policy from interaction_contexts where id=$1",
      [threadScene],
    );
    expect(result.rows[0].npc_intake_policy).toBe("disabled");
    await policy(scene, "disabled");
    expect(await run()).toBe("unauthorized");
    await policy();
    expect(await run()).toBe("accepted");
  });
  it("rejects wrong-world and nonexistent context policy updates without changing policy or audit", async () => {
    const before = await database.pool.query(
      "select * from context_intake_policy_audit where world_id=$1",
      [world],
    );
    await expect(policy(scene, "disabled", foreignWorld)).rejects.toThrow(
      "Context not found",
    );
    await expect(policy(randomUUID())).rejects.toThrow("Context not found");
    expect(
      await database.pool.query(
        "select * from context_intake_policy_audit where world_id=$1",
        [world],
      ),
    ).toMatchObject({ rows: before.rows });
    expect(await run()).toBe("accepted");
  });
  it("does not treat context metadata or user-controlled permission fields as authorization", async () => {
    await database.pool.query(
      "update interaction_contexts set metadata=$1::jsonb where id=$2",
      [
        JSON.stringify({
          allowIntake: true,
          authorizedAuthors: [author],
          physicalPresence: true,
        }),
        scene,
      ],
    );
    await policy(scene, "disabled");
    const input = {
      ...message,
      worldId: world,
      contextId: scene,
      allowIntake: true,
      npcIntakePolicy: "mapped_players",
      botId: "123",
    };
    expect(
      await createDiscordIntake(createDiscordPersistence(database.db))(
        input,
        "123",
      ),
    ).toBe("unauthorized");
    expect(await rows()).toHaveLength(0);
  });
  it("denies replay after persisted policy revocation without restarting intake", async () => {
    expect(await run()).toBe("accepted");
    const [before] = await rows();
    await policy(scene, "disabled");
    expect(await run()).toBe("unauthorized");
    expect(await rows()).toEqual([before]);
    expect(
      await createDiscordIntake(createDiscordPersistence(database.db))(
        message,
        "123",
      ),
    ).toBe("unauthorized");
  });
  it("ignores extra mentioned operators instead of initiating secondary interactions", async () => {
    await mapDiscordUserToEntity(database.db, world, {
      discordUserId: "456",
      entityId: otherNpc,
      mappingType: "npc_operator",
    });
    expect(
      await run({
        ...message,
        content: "<@123> [Garak] Hello <@456> [Other NPC].",
        mentionedUserIds: ["123", "456"],
      }),
    ).toBe("accepted");
    expect((await rows()).map((row) => row.npc_id)).toEqual([npc]);
  });
  it("rejects multiple active player mappings even when one is primary", async () => {
    await mapDiscordUserToEntity(database.db, world, {
      discordUserId: author,
      entityId: secondPc,
      mappingType: "player_character",
    });
    expect(await run()).toBe("ambiguous_speaker");
    await setPrimaryDiscordEntity(database.db, world, author, secondPc);
    expect(await run()).toBe("ambiguous_speaker");
    expect(await rows()).toHaveLength(0);
  });
  it.each([
    "unknown",
    "inactive_mapping",
    "inactive_entity",
    "wrong_world",
    "wrong_type",
    "operator_only",
  ])("rejects %s player identity", async (kind) => {
    if (kind === "inactive_entity")
      await database.pool.query(
        "update entities set status='inactive' where id=$1",
        [pc],
      );
    else if (kind === "wrong_type")
      await database.pool.query(
        "update entities set entity_type='npc' where id=$1",
        [pc],
      );
    else {
      const {
        rows: [identity],
      } = await database.pool.query(
        "select id from discord_identities where world_id=$1 and discord_user_id=$2",
        [world, author],
      );
      await deactivateDiscordUserMapping(database.db, world, identity.id);
      if (kind === "wrong_world") {
        const foreignPc = await createEntity(database.db, foreignWorld, {
          entityType: "player_character",
          canonicalName: "Foreign player",
        });
        await mapDiscordUserToEntity(database.db, foreignWorld, {
          discordUserId: author,
          entityId: foreignPc.id,
          mappingType: "player_character",
        });
      }
      if (kind === "operator_only")
        await mapDiscordUserToEntity(database.db, world, {
          discordUserId: author,
          entityId: otherNpc,
          mappingType: "npc_operator",
        });
    }
    const incoming =
      kind === "unknown" ? { ...message, authorId: "unknown-author" } : message;
    expect(await run(incoming)).toBe("unauthorized");
    expect(await rows()).toHaveLength(0);
  });
  it("resolves the exact thread before parent context and its policy", async () => {
    await mapDiscordContext(database.db, world, {
      ...location,
      threadId: "thread",
      contextId: threadScene,
    });
    const incoming = { ...message, threadId: "thread" };
    expect(await run(incoming)).toBe("unauthorized");
    await policy(threadScene);
    expect(await run(incoming)).toBe("accepted");
    expect((await rows())[0].context_id).toBe(threadScene);
  });
  it("falls back for an unmapped thread but never for an inactive exact context", async () => {
    expect(await run({ ...message, threadId: "unknown-thread" })).toBe(
      "accepted",
    );
    await mapDiscordContext(database.db, world, {
      ...location,
      threadId: "thread",
      contextId: threadScene,
    });
    await database.pool.query(
      "update interaction_contexts set status='inactive' where id=$1",
      [threadScene],
    );
    expect(
      await run({
        ...message,
        sourceMessageId: randomUUID(),
        threadId: "thread",
      }),
    ).toBe("unmapped");
    expect(await rows()).toHaveLength(1);
  });
  it("rejects cross-world location ambiguity even when one world has an exact thread", async () => {
    await mapDiscordContext(database.db, world, {
      ...location,
      threadId: "thread",
      contextId: threadScene,
    });
    await mapDiscordContext(database.db, foreignWorld, {
      ...location,
      contextId: foreignScene,
    });
    expect(await run({ ...message, threadId: "thread" })).toBe(
      "ambiguous_world",
    );
    expect(await rows()).toHaveLength(0);
  });
  it.each(["entity", "npc", "scene", "mapping", "world"])(
    "rejects inactive %s state",
    async (kind) => {
      const updates = {
        entity: ["update entities set status='inactive' where id=$1", npc],
        npc: [
          "update npcs set lifecycle_state='dormant' where entity_id=$1",
          npc,
        ],
        scene: [
          "update interaction_contexts set status='inactive' where id=$1",
          scene,
        ],
        mapping: [
          "update discord_context_mappings set status='inactive' where world_id=$1",
          world,
        ],
        world: ["update worlds set status='archived' where id=$1", world],
      };
      const [query, id] = updates[kind as keyof typeof updates];
      await database.pool.query(query, [id]);
      expect(await run()).toBe(
        ["entity", "npc"].includes(kind) ? "invalid_target" : "unmapped",
      );
      expect(await rows()).toHaveLength(0);
    },
  );
  it("protects concurrent duplicate intake with one durable interaction", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => run()));
    expect(results.filter((result) => result === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result === "duplicate")).toHaveLength(11);
    expect(await rows()).toHaveLength(1);
  });
  it("preserves completed speech, trace and routing during repeated events", async () => {
    expect(await run()).toBe("accepted");
    const [original] = await rows();
    await recordInteractionResponse(database.db, world, npc, original.id, {
      responseText: "Recorded offline speech.",
    });
    await completeInteraction(database.db, world, npc, original.id);
    const [before] = await rows();
    expect(await run()).toBe("duplicate");
    expect(await rows()).toEqual([before]);
    expect(
      await run({ ...message, content: "<@123> [Garak] Replacement content." }),
    ).toBe("event_conflict");
    expect(await rows()).toEqual([before]);
  });
  it("does not retarget a persisted event after alias reassignment", async () => {
    expect(await run()).toBe("accepted");
    const [before] = await rows();
    await database.pool.query(
      "update entity_aliases set entity_id=$1 where entity_id=$2 and normalized_alias='garak'",
      [otherNpc, npc],
    );
    const results = await Promise.all(Array.from({ length: 6 }, () => run()));
    expect(results).toEqual(Array(6).fill("event_conflict"));
    expect(await rows()).toEqual([before]);
  });
  it("does not move an existing event after a scene mapping change", async () => {
    expect(await run()).toBe("accepted");
    const [before] = await rows();
    await database.pool.query(
      "update discord_context_mappings set context_id=$1 where world_id=$2",
      [threadScene, world],
    );
    await policy(threadScene);
    expect(await run()).toBe("event_conflict");
    expect(await rows()).toEqual([before]);
  });
  it("rejects legacy multi-target event ambiguity without adding or altering interactions", async () => {
    for (const target of [npc, otherNpc])
      await createInteraction(database.db, world, target, {
        contextId: scene,
        interactionType: "social",
        communicationMode: "unknown",
        requestText: message.content,
        sourceProvider: "discord",
        sourceMessageId: message.sourceMessageId,
      });
    const before = await rows();
    expect(await run()).toBe("event_conflict");
    expect(await rows()).toEqual(before);
  });
  it.each(["scene", "npc", "mapping", "world", "policy", "identity", "player"])(
    "sees a concurrent committed %s revocation before persistence",
    async (kind) => {
      const client = await database.pool.connect();
      let pending: ReturnType<typeof run> | undefined;
      try {
        await client.query("BEGIN");
        const updates = {
          policy: [
            "update interaction_contexts set npc_intake_policy='disabled' where id=$1",
            scene,
          ],
          identity: [
            "update discord_identities set status='inactive', is_primary=false where world_id=$1",
            world,
          ],
          player: ["update entities set status='inactive' where id=$1", pc],
          scene: [
            "update interaction_contexts set status='inactive' where id=$1",
            scene,
          ],
          npc: [
            "update npcs set lifecycle_state='dormant' where entity_id=$1",
            npc,
          ],
          mapping: [
            "update discord_context_mappings set status='inactive' where world_id=$1",
            world,
          ],
          world: ["update worlds set status='archived' where id=$1", world],
        };
        const [query, id] = updates[kind as keyof typeof updates];
        await client.query(query, [id]);
        const {
          rows: [writer],
        } = await client.query("select pg_backend_pid() as pid");
        pending = run();
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
        expect(await pending).toBe(
          kind === "npc"
            ? "invalid_target"
            : ["policy", "identity", "player"].includes(kind)
              ? "unauthorized"
              : "unmapped",
        );
        expect(await rows()).toHaveLength(0);
      } finally {
        await client.query("ROLLBACK");
        client.release();
        await pending;
      }
    },
  );
  it("waits for authorized intake to commit before completing CLI revocation", async () => {
    const blocker = await database.pool.connect();
    let pending: ReturnType<typeof run> | undefined;
    let revoking: ReturnType<typeof policy> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify(["alias", world, "garak"])],
      );
      const {
        rows: [writer],
      } = await blocker.query("select pg_backend_pid() as pid");
      pending = run();
      let intakePid!: number;
      await vi.waitFor(
        async () => {
          const { rows } = await database.pool.query(
            "select pid from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))",
            [writer.pid],
          );
          expect(rows).toHaveLength(1);
          intakePid = rows[0].pid;
        },
        { timeout: 1500, interval: 10 },
      );
      revoking = policy(scene, "disabled");
      await vi.waitFor(
        async () => {
          const { rows } = await database.pool.query(
            "select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))",
            [intakePid],
          );
          expect(rows.length).toBeGreaterThan(0);
        },
        { timeout: 1500, interval: 10 },
      );
      await blocker.query("COMMIT");
      expect(await pending).toBe("accepted");
      const audit = await revoking;
      expect(audit).toMatchObject({
        previousPolicy: "mapped_players",
        policy: "disabled",
        worldId: world,
        contextId: scene,
      });
      const {
        rows: [stored],
      } = await database.pool.query(
        "select * from context_intake_policy_audit where id=$1",
        [audit.auditId],
      );
      expect(stored).toMatchObject({
        previous_policy: "mapped_players",
        target_policy: "disabled",
      });
      expect(stored.database_role).toBeTruthy();
      const before = await rows();
      expect(await run()).toBe("unauthorized");
      expect(await run({ ...message, sourceMessageId: randomUUID() })).toBe(
        "unauthorized",
      );
      expect(await rows()).toEqual(before);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled([pending, revoking]);
    }
  });
  it("rolls back a policy change when its audit record cannot be persisted", async () => {
    // Fixture-scoped rejection: existing audit rows remain valid and other
    // contexts are unaffected. Always remove the temporary test constraint.
    const constraint = `audit_reject_${randomUUID().replaceAll("-", "")}`;
    const before = await database.pool.query(
      "select * from context_intake_policy_audit where world_id=$1",
      [world],
    );
    await database.pool.query(
      `alter table context_intake_policy_audit add constraint "${constraint}" check (context_id <> '${scene}'::uuid) not valid`,
    );
    try {
      await expect(policy(scene, "disabled")).rejects.toThrow();
      expect(
        (
          await database.pool.query(
            "select npc_intake_policy from interaction_contexts where id=$1",
            [scene],
          )
        ).rows,
      ).toEqual([{ npc_intake_policy: "mapped_players" }]);
      expect(
        (
          await database.pool.query(
            "select * from context_intake_policy_audit where world_id=$1",
            [world],
          )
        ).rows,
      ).toEqual(before.rows);
    } finally {
      await database.pool.query(
        `alter table context_intake_policy_audit drop constraint "${constraint}"`,
      );
    }
  });
  it("fails closed with read-only operator database access and leaves policy and audit unchanged", async () => {
    const before = await database.pool.query(
      "select * from context_intake_policy_audit where world_id=$1",
      [world],
    );
    await expect(
      runContextPolicyCommand(
        ["--world", world, "--context", scene, "--policy", "disabled"],
        () => {
          const pool = new Pool({
            connectionString: getDatabaseConfig().databaseUrl,
            options: "-c default_transaction_read_only=on",
          });
          return {
            pool,
            db: drizzle({ client: pool }),
            close: async () => pool.end(),
          };
        },
      ),
    ).rejects.toThrow();
    expect(
      (
        await database.pool.query(
          "select * from context_intake_policy_audit where world_id=$1",
          [world],
        )
      ).rows,
    ).toEqual(before.rows);
    expect(await run()).toBe("accepted");
  });
  it.each(["alias", "mapping"])(
    "coordinates concurrent %s insertion with the authoritative resolver",
    async (kind) => {
      let release!: () => void, entered!: () => void, writerPid!: number;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const writing = database.db.transaction(async (tx) => {
        const {
          rows: [writer],
        } = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        writerPid = writer.pid;
        if (kind === "alias")
          await addEntityAlias(tx, world, otherNpc, { alias: "Garak" });
        else
          await mapDiscordContext(tx, foreignWorld, {
            ...location,
            contextId: foreignScene,
          });
        entered();
        await gate;
      });
      let pending: ReturnType<typeof run> | undefined;
      try {
        await Promise.race([
          started,
          writing.then(() => {
            throw Error("Writer ended before gate");
          }),
        ]);
        pending = run();
        await vi.waitFor(
          async () => {
            const { rows } = await database.pool.query(
              "select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))",
              [writerPid],
            );
            expect(rows.length).toBeGreaterThan(0);
          },
          { timeout: 1500, interval: 10 },
        );
      } finally {
        release();
        await writing;
      }
      expect(await pending).toBe(
        kind === "alias" ? "ambiguous_target" : "ambiguous_world",
      );
      expect(await rows()).toHaveLength(0);
    },
  );
});
