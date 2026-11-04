import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { describe, it } from "vitest";

// This exercises the real CLI and migrations on a disposable CI-only database.
// It never imports or initializes the Discord SDK, Gateway, LLM or outbound.
const execFileAsync = promisify(execFile);
const adminUrl = process.env.DATABASE_URL;
const targetDatabase = "living_world_gateway_dev";
const targetRole = "lw_gateway_dev";
const worldKey = "lw-dev-gateway-001";
const route = {
  LW_DEV_GUILD_ID: "1111111111111111111",
  LW_DEV_PARENT_CHANNEL_ID: "1222222222222222222",
  LW_DEV_THREAD_ID: "1333333333333333333",
};

function isIsolatedCi(): boolean {
  if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
    return false;
  }
  if (!adminUrl) return false;
  try {
    const url = new URL(adminUrl);
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      decodeURIComponent(url.pathname) === "/living_world_ci" &&
      decodeURIComponent(url.username) === "living_world_ci"
    );
  } catch {
    return false;
  }
}

async function invoke(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, args, {
    env,
    timeout: 45_000,
    maxBuffer: 1_000_000,
  });
}

function safeEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CI: "true",
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    DISCORD_ENABLED: "false",
    DISCORD_OUTBOUND_ENABLED: "false",
    LLM_PROVIDER: "disabled",
    ...route,
  };
}

async function cli(
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<{
  status: string;
  worldKey: string;
  worldId?: string;
  contextId?: string;
  npcId?: string;
}> {
  const result = await invoke(
    ["--import", "tsx", "src/admin/discord-dev-fixture.ts", ...args],
    env,
  );
  assert.equal(result.stderr.trim(), "");
  return JSON.parse(result.stdout.trim()) as {
    status: string;
    worldKey: string;
    worldId?: string;
    contextId?: string;
    npcId?: string;
  };
}

async function rejectsCli(env: NodeJS.ProcessEnv, ...args: string[]) {
  await assert.rejects(
    () =>
      invoke(
        ["--import", "tsx", "src/admin/discord-dev-fixture.ts", ...args],
        env,
      ),
    (error: unknown) => {
      assert.equal((error as { code?: number }).code, 1);
      const output = error as { stdout?: string; stderr?: string };
      assert.equal(output.stdout?.trim() ?? "", "");
      assert.match(output.stderr ?? "", /DEV fixture failed safely/u);
      assert.doesNotMatch(output.stderr ?? "", /postgresql:\/\//u);
      return true;
    },
  );
}

async function snapshot(client: pg.Client) {
  const tables = [
    "worlds",
    "entities",
    "npcs",
    "npc_state",
    "npc_game_profiles",
    "npc_capabilities",
    "entity_aliases",
    "interaction_contexts",
    "discord_context_mappings",
    "discord_identities",
    "local_presence",
    "interactions",
    "npc_response_deliveries",
    "context_intake_policy_audit",
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await client.query<{ count: number }>(
      `select count(*)::int as count from ${table}`,
    );
    counts[table] = result.rows[0]!.count;
  }
  const data = await client.query(
    "select w.id as world_id, w.key, w.updated_at as world_updated, " +
      "c.id as context_id, c.updated_at as context_updated, " +
      "c.npc_intake_policy, c.external_guild_id, " +
      "c.external_channel_id, c.external_thread_id, " +
      "m.guild_id, m.channel_id, m.thread_id, m.mapping_type, m.status " +
      "from worlds w join interaction_contexts c on c.world_id = w.id " +
      "join discord_context_mappings m on m.context_id = c.id " +
      "where w.key = $1",
    [worldKey],
  );
  return { counts, rows: data.rows };
}

describe("Discord DEV fixture real CLI smoke on disposable PostgreSQL 17", () => {
  it.skipIf(!isIsolatedCi())(
    "checks preview/apply/replay, DB identity and fail-closed routing",
    async () => {
      assert.ok(adminUrl);
      const admin = new pg.Client({ connectionString: adminUrl });
      const password = randomBytes(24).toString("hex");
      const devUrl = new URL(adminUrl);
      devUrl.username = targetRole;
      devUrl.password = password;
      devUrl.pathname = "/" + targetDatabase;
      const devEnv = safeEnv(devUrl.toString());
      let roleCreated = false;
      let databaseCreated = false;
      let dev: pg.Client | undefined;
      await admin.connect();
      try {
        // Never create or drop objects on an unverified database connection.
        const identity = await admin.query<{
          database: string;
          role: string;
          version: number;
          superuser: boolean;
        }>(
          "select current_database() as database, current_user as role, " +
            "current_setting('server_version_num')::int as version, " +
            "(select rolsuper from pg_roles where rolname=current_user) as superuser",
        );
        assert.deepEqual(identity.rows[0], {
          database: "living_world_ci",
          role: "living_world_ci",
          version: identity.rows[0]?.version,
          superuser: true,
        });
        assert.ok(
          identity.rows[0]!.version >= 170000 &&
            identity.rows[0]!.version < 180000,
        );
        const prior = await admin.query(
          "select (select count(*)::int from pg_roles where rolname = $1) as roles, " +
            "(select count(*)::int from pg_database where datname = $2) as databases",
          [targetRole, targetDatabase],
        );
        assert.equal(prior.rows[0].roles, 0);
        assert.equal(prior.rows[0].databases, 0);
        await admin.query(
          `create role ${targetRole} login password '${password}'`,
        );
        roleCreated = true;
        await admin.query(
          `create database ${targetDatabase} owner ${targetRole}`,
        );
        databaseCreated = true;

        await invoke(
          ["./node_modules/drizzle-kit/bin.cjs", "migrate"],
          safeEnv(devUrl.toString()),
        );
        dev = new pg.Client({ connectionString: devUrl.toString() });
        await dev.connect();
        const baseline = await snapshot(dev);
        assert.ok(Object.values(baseline.counts).every((n) => n === 0));

        assert.deepEqual(await cli(devEnv), {
          status: "would_create",
          worldKey,
        });
        assert.deepEqual(await snapshot(dev), baseline);

        const first = await cli(
          devEnv,
          "--apply",
          "--confirm-database",
          targetDatabase,
        );
        assert.equal(first.status, "created");
        assert.equal(first.worldKey, worldKey);
        assert.ok(first.worldId && first.contextId && first.npcId);
        const created = await snapshot(dev);
        assert.deepEqual(created.counts, {
          worlds: 1,
          entities: 3,
          npcs: 1,
          npc_state: 1,
          npc_game_profiles: 0,
          npc_capabilities: 0,
          entity_aliases: 1,
          interaction_contexts: 1,
          discord_context_mappings: 1,
          discord_identities: 0,
          local_presence: 0,
          interactions: 0,
          npc_response_deliveries: 0,
          context_intake_policy_audit: 0,
        });
        assert.equal(created.rows.length, 1);
        assert.equal(created.rows[0].world_id, first.worldId);
        assert.equal(created.rows[0].context_id, first.contextId);
        assert.equal(created.rows[0].npc_intake_policy, "disabled");
        assert.equal(created.rows[0].external_guild_id, route.LW_DEV_GUILD_ID);
        assert.equal(
          created.rows[0].external_channel_id,
          route.LW_DEV_PARENT_CHANNEL_ID,
        );
        assert.equal(created.rows[0].external_thread_id, route.LW_DEV_THREAD_ID);
        assert.equal(created.rows[0].guild_id, route.LW_DEV_GUILD_ID);
        assert.equal(created.rows[0].channel_id, route.LW_DEV_PARENT_CHANNEL_ID);
        assert.equal(created.rows[0].thread_id, route.LW_DEV_THREAD_ID);
        assert.equal(created.rows[0].mapping_type, "scene");
        assert.equal(created.rows[0].status, "active");

        const second = { ...first, status: "already_present" };
        assert.deepEqual(await cli(devEnv), second);
        assert.deepEqual(
          await cli(
            devEnv,
            "--apply",
            "--confirm-database",
            targetDatabase,
          ),
          second,
        );
        assert.deepEqual(await snapshot(dev), created);

        await rejectsCli({
          ...devEnv,
          LW_DEV_THREAD_ID: "1444444444444444444",
        });
        await rejectsCli({ ...devEnv, DISCORD_ENABLED: "true" });
        await rejectsCli(safeEnv(adminUrl));
        assert.deepEqual(await snapshot(dev), created);
      } finally {
        if (dev) await dev.end();
        if (databaseCreated) {
          await admin.query(`drop database ${targetDatabase} with (force)`);
        }
        if (roleCreated) await admin.query(`drop role ${targetRole}`);
        await admin.end();
      }
    },
    120_000,
  );
});
