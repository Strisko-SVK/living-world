import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { createDatabaseClient } from "../db/client.js";
import {
  provisionDevFixture,
  validateDevFixtureEnvironment,
  type DevFixtureRoute,
} from "./discord-dev-fixture.js";
import { validateGatewayDevDatabaseEnv } from "./gateway-dev-db.js";

export const pilotWorldKey = "lw-dev-pilot-001";
const databaseName = "living_world_gateway_dev";
const idPattern = /^\d{17,20}$/u;

export function validatePilotFixtureEnvironment(
  environment: NodeJS.ProcessEnv,
): DevFixtureRoute {
  validateGatewayDevDatabaseEnv(environment);
  const original = validateDevFixtureEnvironment(environment);
  const channelId = environment.LW_PILOT_PARENT_CHANNEL_ID ?? "";
  const threadId = environment.LW_PILOT_THREAD_ID ?? "";

  if (!idPattern.test(channelId) || !idPattern.test(threadId))
    throw new Error("Pilot requires a valid new parent channel and thread.");
  if (
    channelId === threadId ||
    channelId === original.guildId ||
    threadId === original.guildId ||
    channelId === original.channelId ||
    threadId === original.channelId ||
    channelId === original.threadId ||
    threadId === original.threadId
  )
    throw new Error(
      "Pilot route must be distinct from the pristine DEV route.",
    );

  // The pilot must stay in the existing private DEV guild, not an arbitrary
  // guild supplied by the operator or an untrusted Discord event.
  if (
    environment.LW_PILOT_GUILD_ID !== undefined &&
    environment.LW_PILOT_GUILD_ID !== original.guildId
  )
    throw new Error("Pilot guild must match the isolated DEV guild.");

  return { guildId: original.guildId, channelId, threadId };
}

export function parsePilotFixtureArguments(args: readonly string[]): boolean {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return false;
  if (
    args.length === 5 &&
    args[0] === "--apply" &&
    args[1] === "--confirm-world" &&
    args[2] === pilotWorldKey &&
    args[3] === "--confirm-database" &&
    args[4] === databaseName
  )
    return true;
  throw new Error(
    "Pilot apply requires exact world and database confirmation.",
  );
}

export async function runPilotFixtureCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
) {
  const apply = parsePilotFixtureArguments(args);
  const route = validatePilotFixtureEnvironment(environment);
  const client = connect(environment);
  try {
    // Match the existing fixture's same-transaction DB-identity guard.
    return await client.db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout='5s'`);
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
        throw new Error("Pilot database identity is not approved.");
      // Reuse the existing strict, transactional, default-deny fixture.
      // A DIFFERENT PARENT channel is mandatory: same-parent route additions
      // would invalidate the pristine fixture replay.
      return provisionDevFixture(tx, route, apply, pilotWorldKey);
    });
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runPilotFixtureCommand(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      // Never log database URLs, tokens, SQL or user/campaign data.
      console.error(JSON.stringify({ event: "pilot_fixture_failed_safely" }));
      process.exitCode = 1;
    },
  );
}
