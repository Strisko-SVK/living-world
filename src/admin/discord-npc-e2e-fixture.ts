import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { createDatabaseClient } from "../db/client.js";
import {
  provisionDevFixture,
  validateDevFixtureEnvironment,
  type DevFixtureRoute,
} from "./discord-dev-fixture.js";
import { validatePilotFixtureEnvironment } from "./discord-pilot-fixture.js";

export const npcE2eWorldKey = "lw-dev-npc-e2e-001";
const databaseName = "living_world_gateway_dev";
const snowflake = /^\d{17,20}$/u;

// A NEW fixture: never route to the pristine Step 8 scene or the consumed
// Step 14 pilot. No Discord transport, LLM or production runtime imports.
export function validateNpcE2eFixtureEnvironment(
  environment: NodeJS.ProcessEnv,
): DevFixtureRoute {
  const baseline = validateDevFixtureEnvironment(environment);
  const consumedPilot = validatePilotFixtureEnvironment(environment);
  const channelId = environment.LW_NPC_E2E_PARENT_CHANNEL_ID ?? "";
  const threadId = environment.LW_NPC_E2E_THREAD_ID ?? "";
  if (!snowflake.test(channelId) || !snowflake.test(threadId))
    throw new Error("NPC E2E requires a new valid parent and thread.");
  if (
    environment.LW_NPC_E2E_GUILD_ID !== undefined &&
    environment.LW_NPC_E2E_GUILD_ID !== baseline.guildId
  )
    throw new Error("NPC E2E must use the existing private DEV guild.");

  const reserved = new Set([
    baseline.guildId,
    baseline.channelId,
    baseline.threadId,
    consumedPilot.channelId,
    consumedPilot.threadId,
  ]);
  if (
    channelId === threadId ||
    reserved.has(channelId) ||
    reserved.has(threadId)
  )
    throw new Error(
      "NPC E2E route must not reuse a pristine or consumed pilot route.",
    );
  return { guildId: baseline.guildId, channelId, threadId };
}

export function parseNpcE2eFixtureArguments(args: readonly string[]): boolean {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return false;
  if (
    args.length === 5 &&
    args[0] === "--apply" &&
    args[1] === "--confirm-world" &&
    args[2] === npcE2eWorldKey &&
    args[3] === "--confirm-database" &&
    args[4] === databaseName
  )
    return true;
  throw new Error(
    "NPC E2E apply requires exact world and DEV database confirmation.",
  );
}

// Operator-only, default read-only. The apply mode exists for later explicit
// authorization; this implementation does not authorize its execution.
export async function runNpcE2eFixtureCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
) {
  const apply = parseNpcE2eFixtureArguments(args);
  const route = validateNpcE2eFixtureEnvironment(environment);
  const client = connect(environment);
  try {
    return await client.db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const identity = await tx.execute(sql`
        select current_database() as database, current_user as db_role,
          current_setting('server_version_num')::int as version,
          (select rolsuper from pg_roles where rolname=current_user) as superuser
      `);
      const row = identity.rows[0];
      if (
        !row ||
        row.database !== databaseName ||
        row.db_role !== "lw_gateway_dev" ||
        typeof row.version !== "number" ||
        row.version < 170000 ||
        row.version >= 180000 ||
        row.superuser !== false
      )
        throw new Error("NPC E2E database identity is not approved.");

      // Reuse the same reviewed, transactional, default-deny fixture.
      // It refuses a foreign parent mapping, policy drift and used worlds.
      return provisionDevFixture(tx, route, apply, npcE2eWorldKey);
    });
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runNpcE2eFixtureCommand(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      // Never print tokens, user/message identifiers, DB URLs or SQL.
      console.error(JSON.stringify({ event: "npc_e2e_fixture_failed_safely" }));
      process.exitCode = 1;
    },
  );
}
