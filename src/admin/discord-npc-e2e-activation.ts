import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { worlds } from "../db/schema/worlds.js";
import { grantLocalPresence } from "../communication/local.repository.js";
import { updateNpcState } from "../domains/npc/npc.repository.js";
import {
  provisionDevFixture,
  type DevFixtureRoute,
} from "./discord-dev-fixture.js";
import {
  npcE2eWorldKey,
  validateNpcE2eFixtureEnvironment,
} from "./discord-npc-e2e-fixture.js";
import { runNpcE2eReadinessCommand } from "./discord-npc-e2e-readiness.js";
import { reconcilePilotPlayer } from "./discord-pilot-player.js";
import { reconcilePilotPolicy } from "./discord-pilot-policy.js";
import { validateGatewayDevDatabaseEnv } from "./gateway-dev-db.js";

type Database = Omit<DatabaseClient["db"], "$client">;
const expectedDatabase = "living_world_gateway_dev";
const expectedRole = "lw_gateway_dev";
const botId = "1566909036899868712";
const snowflake = /^\d{17,20}$/u;

const confirmedIdsSchema = z
  .object({
    worldId: z.string().uuid(),
    contextId: z.string().uuid(),
    npcId: z.string().uuid(),
  })
  .strict();
export type NpcE2eIds = z.infer<typeof confirmedIdsSchema>;
export type ActivationMode = "preview" | "activate" | "disable";
export type ActivationArguments =
  | { mode: "preview" }
  | { mode: "activate" | "disable"; ids: NpcE2eIds };
export type ActivationRequest = {
  route: DevFixtureRoute;
  ids: NpcE2eIds;
  userId: string;
};

export function parseNpcE2eActivationArguments(
  args: readonly string[],
): ActivationArguments {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return { mode: "preview" };
  if (
    args.length !== 11 ||
    (args[0] !== "--activate" && args[0] !== "--disable") ||
    args[1] !== "--confirm-world" ||
    args[2] !== npcE2eWorldKey ||
    args[3] !== "--confirm-world-id" ||
    args[5] !== "--confirm-context" ||
    args[7] !== "--confirm-npc" ||
    args[9] !== "--confirm-database" ||
    args[10] !== expectedDatabase
  )
    throw new Error("NPC E2E activation requires exact DEV world, UUIDs and database.");
  return {
    mode: args[0],
    ids: confirmedIdsSchema.parse({
      worldId: args[4],
      contextId: args[6],
      npcId: args[8],
    }),
  };
}

export function validateNpcE2eActivationEnvironment(
  environment: NodeJS.ProcessEnv,
  mode: ActivationMode,
) {
  // Stricter than the generic fixture: exact local host, port, role and
  // disabled Discord/LLM environment are required for operator access.
  validateGatewayDevDatabaseEnv(environment);
  const route = validateNpcE2eFixtureEnvironment(environment);
  const userId = environment.LW_NPC_E2E_TEST_USER_ID;
  if (mode === "activate" && (!userId || !snowflake.test(userId)))
    throw new Error("NPC E2E test human must be configured privately.");
  if (userId !== undefined) {
    const reserved = [
      botId,
      route.guildId,
      route.channelId,
      route.threadId,
      environment.LW_DEV_PARENT_CHANNEL_ID,
      environment.LW_DEV_THREAD_ID,
      environment.LW_PILOT_PARENT_CHANNEL_ID,
      environment.LW_PILOT_THREAD_ID,
    ];
    if (!snowflake.test(userId) || reserved.includes(userId))
      throw new Error("NPC E2E test human ID is not valid.");
  }
  return { route, userId };
}

// Operator-only function. Does NOT run in the Discord adapter or runtime.
// Requires a fresh, pristine fixture; every mutation is in one transaction.
// A partial failure rolls back identity, NPC state, presence and policy together.
export async function activateNpcE2e(
  database: Database,
  request: ActivationRequest,
) {
  confirmedIdsSchema.parse(request.ids);
  if (
    !snowflake.test(request.userId) ||
    request.userId === botId ||
    Object.values(request.route).includes(request.userId)
  )
    throw new Error("The approved test user ID is invalid.");
  return database.transaction(async (tx) => {
    const baseline = await provisionDevFixture(
      tx,
      request.route,
      false,
      npcE2eWorldKey,
    );
    if (
      baseline.status !== "already_present" ||
      baseline.worldId !== request.ids.worldId ||
      baseline.contextId !== request.ids.contextId ||
      baseline.npcId !== request.ids.npcId
    )
      throw new Error("Confirmed NPC E2E fixture IDs do not match pristine data.");

    const trigger = await tx.execute(
      sql.raw(
        "select exists (select 1 from pg_trigger t " +
          "join pg_class c on c.oid=t.tgrelid " +
          "join pg_namespace n on n.oid=c.relnamespace " +
          "where t.tgname='discord_route_revision' and t.tgenabled='O' " +
          "and c.relname='discord_context_mappings' " +
          "and n.nspname='public' and not t.tgisinternal) as installed",
      ),
    );
    if (trigger.rows[0]?.installed !== true)
      throw new Error("Migration 0017 route revision protection is not active.");

    const [scene] = await tx
      .select()
      .from(interactionContexts)
      .where(eq(interactionContexts.id, request.ids.contextId))
      .for("share");
    if (
      !scene ||
      scene.worldId !== request.ids.worldId ||
      scene.npcIntakePolicy !== "disabled" ||
      !scene.linkedLocationEntityId
    )
      throw new Error("NPC E2E scene must be pristine and default deny.");

    const enrollment = await reconcilePilotPlayer(tx, {
      worldKey: npcE2eWorldKey,
      route: request.route,
      userId: request.userId,
      mode: "enroll",
    });
    if (enrollment.event !== "pilot_player_enrolled")
      throw new Error("NPC E2E test player was not newly enrolled.");

    const state = await updateNpcState(
      tx,
      request.ids.worldId,
      request.ids.npcId,
      {
        currentLocationId: scene.linkedLocationEntityId,
        locationCertainty: "certain",
        expectedVersion: 1,
      },
    );
    if (
      !state ||
      state.version !== 2 ||
      state.currentLocationId !== scene.linkedLocationEntityId ||
      state.locationCertainty !== "certain"
    )
      throw new Error("Authoritative NPC location update failed.");

    const presence = await grantLocalPresence(tx, {
      worldId: request.ids.worldId,
      npcId: request.ids.npcId,
      contextId: request.ids.contextId,
    });
    if (presence.status !== "granted")
      throw new Error("NPC local presence could not be granted.");

    // Policy is enabled last; the transaction commits only if every
    // prerequisite and the mandatory audit record succeed.
    const policy = await reconcilePilotPolicy(tx, {
      worldKey: npcE2eWorldKey,
      route: request.route,
      mode: "enable",
      confirmedContextId: request.ids.contextId,
      testUserId: request.userId,
    });
    if (
      policy.event !== "pilot_policy_changed" ||
      policy.policy !== "mapped_players"
    )
      throw new Error("NPC E2E intake policy activation failed.");
    return {
      event: "npc_e2e_activated",
      worldKey: npcE2eWorldKey,
      worldId: request.ids.worldId,
      contextId: request.ids.contextId,
      npcId: request.ids.npcId,
      mappingId: enrollment.mappingId,
      presenceId: presence.evidence.id,
      policyAuditId: policy.auditId,
    };
  });
}

// Emergency default-deny switch. Does not depend on the private human ID,
// preserved even if the original human mapping/config is unavailable.
export async function disableNpcE2eIntake(
  database: Database,
  request: { route: DevFixtureRoute; ids: NpcE2eIds },
) {
  confirmedIdsSchema.parse(request.ids);
  return database.transaction(async (tx) => {
    const found = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.key, npcE2eWorldKey));
    const scenes = await tx
      .select()
      .from(interactionContexts)
      .where(eq(interactionContexts.worldId, request.ids.worldId));
    if (
      found.length !== 1 ||
      found[0]!.id !== request.ids.worldId ||
      scenes.length !== 1 ||
      scenes[0]!.id !== request.ids.contextId ||
      scenes[0]!.externalGuildId !== request.route.guildId ||
      scenes[0]!.externalChannelId !== request.route.channelId ||
      scenes[0]!.externalThreadId !== request.route.threadId
    )
      throw new Error("Emergency disable does not match the isolated fixture.");
    const policy = await reconcilePilotPolicy(tx, {
      worldKey: npcE2eWorldKey,
      route: request.route,
      mode: "disable",
      confirmedContextId: request.ids.contextId,
    });
    if (
      policy.event !== "pilot_policy_changed" &&
      policy.event !== "pilot_policy_already_disabled"
    )
      throw new Error("NPC E2E intake could not be disabled.");
    return {
      event: "npc_e2e_intake_disabled",
      worldKey: npcE2eWorldKey,
      contextId: request.ids.contextId,
      alreadyDisabled: policy.event === "pilot_policy_already_disabled",
    };
  });
}

export async function runNpcE2eActivationCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
) {
  const parsed = parseNpcE2eActivationArguments(args);
  const { route, userId } = validateNpcE2eActivationEnvironment(
    environment,
    parsed.mode,
  );
  if (parsed.mode === "preview") {
    return runNpcE2eReadinessCommand(["--preview"], environment, connect);
  }
  const client = connect(environment);
  try {
    return await client.db.transaction(async (tx) => {
      await tx.execute(sql.raw("set local lock_timeout = '2s'"));
      await tx.execute(sql.raw("set local statement_timeout = '15s'"));
      const identity = await tx.execute(
        sql.raw(
          "select current_database() as database, current_user as db_role, " +
            "current_setting('server_version_num')::int as version, " +
            "(select rolsuper from pg_roles where rolname=current_user) as superuser, " +
            "(select rolcreatedb from pg_roles where rolname=current_user) as createdb, " +
            "(select rolcreaterole from pg_roles where rolname=current_user) as createrole",
        ),
      );
      const role = identity.rows[0];
      if (
        !role ||
        role.database !== expectedDatabase ||
        role.db_role !== expectedRole ||
        typeof role.version !== "number" ||
        role.version < 170000 ||
        role.version >= 180000 ||
        role.superuser !== false ||
        role.createdb !== false ||
        role.createrole !== false
      )
        throw new Error("NPC E2E activation requires the isolated DEV database.");

      if (parsed.mode === "disable")
        return disableNpcE2eIntake(tx, { route, ids: parsed.ids });
      if (!userId) throw new Error("NPC E2E human is missing.");
      return activateNpcE2e(tx, { route, ids: parsed.ids, userId });
    });
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runNpcE2eActivationCommand(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      // Never print personal Discord IDs, bot tokens, DB URLs or SQL.
      console.error(JSON.stringify({ event: "npc_e2e_activation_failed_safely" }));
      process.exitCode = 1;
    },
  );
}
