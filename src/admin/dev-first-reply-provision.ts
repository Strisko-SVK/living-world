import { pathToFileURL } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { grantLocalPresence } from "../communication/local.repository.js";
import {
  issueHostSceneSpeechPolicy,
  revokeHostSceneSpeechPolicy,
} from "../communication/scene-speech-policies.repository.js";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { discordContextMappings } from "../db/schema/discord-context-mappings.js";
import { entities } from "../db/schema/entities.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { localPresence } from "../db/schema/local-presence.js";
import { worlds } from "../db/schema/worlds.js";
import { updateNpcState } from "../domains/npc/npc.repository.js";
import { gatewaySmokeBotId } from "./discord-gateway-smoke.js";
import {
  provisionDevFixture,
  type DevFixtureRoute,
} from "./discord-dev-fixture.js";
import { reconcilePilotPlayer } from "./discord-pilot-player.js";
import { reconcilePilotPolicy } from "./discord-pilot-policy.js";
import { validateGatewayDevDatabaseEnv } from "./gateway-dev-db.js";

// Only this NEW route/world may be provisioned by the owner-local entrypoint.
// The old, consumed Sentinel E2E world and Discord routes are never modified.
export const firstReplyWorldKey = "lw-dev-first-reply-001";
const databaseName = "living_world_gateway_dev";
const databaseRole = "lw_gateway_dev";
const snowflake = /^[1-9][0-9]{16,19}$/u;
const routeSchema = z
  .object({
    guildId: z.string().regex(snowflake),
    channelId: z.string().regex(snowflake),
    threadId: z.string().regex(snowflake),
  })
  .strict();
type Database = Omit<DatabaseClient["db"], "$client">;
export type FirstReplyProvisionMode = "preview" | "prepare" | "disable";

export function validateFirstReplyProvisionEnvironment(
  env: NodeJS.ProcessEnv,
  mode: FirstReplyProvisionMode,
): { route: DevFixtureRoute; userId?: string } {
  validateGatewayDevDatabaseEnv(env);
  const route = routeSchema.parse({
    guildId: env.LW_FIRST_REPLY_GUILD_ID,
    channelId: env.LW_FIRST_REPLY_PARENT_ID,
    threadId: env.LW_FIRST_REPLY_THREAD_ID,
  });
  const historical = [
    env.LW_DEV_PARENT_CHANNEL_ID,
    env.LW_DEV_THREAD_ID,
    env.LW_PILOT_PARENT_CHANNEL_ID,
    env.LW_PILOT_THREAD_ID,
    env.LW_NPC_E2E_PARENT_CHANNEL_ID,
    env.LW_NPC_E2E_THREAD_ID,
  ];
  if (
    env.LW_FIRST_REPLY_WORLD_KEY !== firstReplyWorldKey ||
    route.guildId !== env.LW_DEV_GUILD_ID ||
    historical.some((id) => !id || !snowflake.test(id)) ||
    new Set(Object.values(route)).size !== 3 ||
    historical.includes(route.channelId) ||
    historical.includes(route.threadId)
  )
    throw new Error("First reply requires a new isolated DEV route and world.");
  const userId = env.LW_FIRST_REPLY_PLAYER_ID;
  if (
    mode === "prepare" &&
    (!userId ||
      !snowflake.test(userId) ||
      userId === gatewaySmokeBotId ||
      Object.values(route).includes(userId) ||
      historical.includes(userId))
  )
    throw new Error("First reply requires one private human test player.");
  // Deliberately no dependency on the player's private ID for emergency stop.
  return { route, ...(mode === "prepare" ? { userId } : {}) };
}

export function parseFirstReplyProvisionArguments(
  args: readonly string[],
  route: DevFixtureRoute,
): FirstReplyProvisionMode {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return "preview";
  if (
    args.length === 10 &&
    (args[0] === "--prepare" || args[0] === "--disable") &&
    args[1] === "--confirm-world" &&
    args[2] === firstReplyWorldKey &&
    args[3] === "--confirm-parent" &&
    args[4] === route.channelId &&
    args[5] === "--confirm-thread" &&
    args[6] === route.threadId &&
    args[7] === "--confirm-database" &&
    args[8] === databaseName &&
    args[9] === "--offline-only"
  )
    return args[0] === "--prepare" ? "prepare" : "disable";
  throw new Error("Exact one-scene DEV confirmation is required.");
}

export type FirstReplyProvisionResult = {
  event: "npc_first_reply_provision";
  status:
    | "fresh_route_candidate"
    | "existing_review_required"
    | "prepared"
    | "disabled"
    | "already_disabled";
  worldKey: typeof firstReplyWorldKey;
  canSend: false;
  readOnly: boolean;
  worldId?: string;
  contextId?: string;
  npcId?: string;
  playerMappingId?: string;
  presenceId?: string;
  policyAuditId?: string;
  hostPolicyId?: string;
};

async function assertLocalDatabaseIdentity(tx: Database): Promise<void> {
  const result = await tx.execute(sql`
    select current_database() as database, current_user as db_role,
      current_setting('server_version_num')::int as version,
      (select rolsuper from pg_roles where rolname=current_user) as superuser,
      (select rolcreatedb from pg_roles where rolname=current_user) as createdb,
      (select rolcreaterole from pg_roles where rolname=current_user) as createrole,
      (select pg_get_userbyid(datdba) from pg_database
        where datname=current_database()) as db_owner,
      to_regclass('public.npc_dev_first_reply_consents')::text as consent_table
  `);
  const row = result.rows[0];
  if (
    row?.database !== databaseName ||
    row.db_role !== databaseRole ||
    row.db_owner !== databaseRole ||
    typeof row.version !== "number" ||
    row.version < 170000 ||
    row.version >= 180000 ||
    row.superuser !== false ||
    row.createdb !== false ||
    row.createrole !== false ||
    row.consent_table !== "npc_dev_first_reply_consents"
  )
    throw new Error(
      "The exact migrated, isolated local DEV database is required.",
    );

  const guards = await tx.execute(sql`
    select tgname from pg_trigger
    where not tgisinternal and tgenabled='O'
      and tgname in ('discord_route_revision',
        'scene_speech_policy_immutable', 'scene_speech_policy_no_truncate')
  `);
  if (new Set(guards.rows.map((row) => row.tgname)).size !== 3)
    throw new Error(
      "Required Discord routing and host-policy guards are missing.",
    );
}

// One owner-approved transaction: new synthetic world -> one mapped human ->
// Sentinel state/presence -> mapped_players -> PRE-EVENT host speech policy.
// No Discord connection, REST, webhook, LLM, or delivery capability exists here.
export async function prepareFirstReplyFixture(
  db: Database,
  route: DevFixtureRoute,
  userId: string,
  worldKey = firstReplyWorldKey,
): Promise<FirstReplyProvisionResult> {
  // The reviewed migration 0019 intentionally accepts synthetic CI keys
  // in living_world_ci, but ONLY lw-dev-first-reply-* in owner DEV.
  // CLI does not expose this argument; no operator may change owner world.
  if (
    worldKey !== firstReplyWorldKey &&
    !(process.env.NODE_ENV === "test" &&
      /^npc-gateway-ci-[a-f0-9-]{36}$/u.test(worldKey))
  )
    throw Error("Only the fixed first-reply DEV world is allowed.");
  if (
    !snowflake.test(userId) ||
    userId === gatewaySmokeBotId ||
    Object.values(route).includes(userId)
  )
    throw new Error("Invalid synthetic first-reply human ID.");
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: worlds.id })
      .from(worlds)
      .where(eq(worlds.key, worldKey))
      .limit(1);
    if (existing)
      throw new Error(
        "First-reply fixture already exists; no automatic replay.",
      );

    const created = await provisionDevFixture(
      tx,
      route,
      true,
      worldKey,
    );
    if (
      created.status !== "created" ||
      !created.worldId ||
      !created.contextId ||
      !created.npcId
    )
      throw new Error("First-reply fixture was not freshly created.");

    const ids = {
      worldId: created.worldId,
      contextId: created.contextId,
      npcId: created.npcId,
    };
    const [scene] = await tx
      .select()
      .from(interactionContexts)
      .where(eq(interactionContexts.id, ids.contextId));
    if (!scene?.linkedLocationEntityId || scene.npcIntakePolicy !== "disabled")
      throw new Error("First-reply scene must start default-deny.");

    const enrolled = await reconcilePilotPlayer(tx, {
      worldKey,
      route,
      userId,
      mode: "enroll",
    });
    if (
      enrolled.event !== "pilot_player_enrolled" ||
      !("mappingId" in enrolled) ||
      typeof enrolled.mappingId !== "string"
    )
      throw new Error("First-reply player enrollment failed.");

    const state = await updateNpcState(tx, ids.worldId, ids.npcId, {
      currentLocationId: scene.linkedLocationEntityId,
      locationCertainty: "certain",
      expectedVersion: 1,
    });
    if (
      !state ||
      state.version !== 2 ||
      state.currentLocationId !== scene.linkedLocationEntityId
    )
      throw new Error("Sentinel state setup failed.");
    const presence = await grantLocalPresence(tx, ids);
    if (presence.status !== "granted")
      throw new Error("Sentinel local presence setup failed.");

    const policy = await reconcilePilotPolicy(tx, {
      worldKey,
      route,
      mode: "enable",
      confirmedContextId: ids.contextId,
      testUserId: userId,
    });
    if (
      policy.event !== "pilot_policy_changed" ||
      policy.policy !== "mapped_players" ||
      !("auditId" in policy) ||
      typeof policy.auditId !== "string"
    )
      throw new Error("First-reply mapped-player intake setup failed.");

    const members = await tx
      .select()
      .from(entities)
      .where(eq(entities.worldId, ids.worldId));
    const human = members.filter(
      (member) =>
        member.entityType === "player_character" &&
        member.canonicalName === "Gateway Test Character" &&
        member.status === "active",
    );
    if (members.length !== 3 || human.length !== 1)
      throw new Error("First-reply host attribution is not isolated.");

    // The existing synthetic player entity is only a host-policy issuer label.
    // It is NOT independent owner/DM authentication or authorization to send.
    const hostPolicy = await issueHostSceneSpeechPolicy(tx, {
      ...ids,
      presenceId: presence.evidence.id,
      issuerEntityId: human[0]!.id,
      decision: "allow_direct_speech",
      activity: "free",
      perception: "aware",
      otherScene: "none",
      ttlMinutes: 30,
    });
    if (hostPolicy.status !== "created")
      throw new Error("Pre-event host speech policy was not recorded.");

    return {
      event: "npc_first_reply_provision",
      status: "prepared",
      worldKey: firstReplyWorldKey,
      canSend: false,
      readOnly: false,
      ...ids,
      playerMappingId: enrolled.mappingId,
      presenceId: presence.evidence.id,
      policyAuditId: policy.auditId,
      hostPolicyId: hostPolicy.id,
    };
  });
}

// Owner-local emergency switch, independent of the private test-player ID.
// It never deletes or re-arms an event, route, consent or outbox record.
export async function disableFirstReplyFixture(
  db: Database,
  route: DevFixtureRoute,
): Promise<FirstReplyProvisionResult> {
  return db.transaction(async (tx) => {
    const [world] = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.key, firstReplyWorldKey));
    if (!world || world.systemType !== "test")
      throw new Error("First-reply world is missing or unsafe.");

    const scenes = await tx
      .select()
      .from(interactionContexts)
      .where(eq(interactionContexts.worldId, world.id));
    const routes = await tx
      .select()
      .from(discordContextMappings)
      .where(
        and(
          eq(discordContextMappings.guildId, route.guildId),
          eq(discordContextMappings.channelId, route.channelId),
        ),
      );
    const members = await tx
      .select()
      .from(entities)
      .where(eq(entities.worldId, world.id));
    const scene = scenes[0];
    const mapping = routes[0];
    const npc = members.filter(
      (member) =>
        member.entityType === "npc" &&
        member.canonicalName === "Sentinel-001" &&
        member.status === "active",
    );
    if (
      scenes.length !== 1 ||
      !scene ||
      scene.externalGuildId !== route.guildId ||
      scene.externalChannelId !== route.channelId ||
      scene.externalThreadId !== route.threadId ||
      routes.length !== 1 ||
      !mapping ||
      mapping.worldId !== world.id ||
      mapping.contextId !== scene.id ||
      mapping.threadId !== route.threadId ||
      mapping.status !== "active" ||
      npc.length !== 1
    )
      throw new Error("First-reply emergency stop scope does not match.");

    const intake = await reconcilePilotPolicy(tx, {
      worldKey: firstReplyWorldKey,
      route,
      mode: "disable",
      confirmedContextId: scene.id,
    });
    if (
      intake.event !== "pilot_policy_changed" &&
      intake.event !== "pilot_policy_already_disabled"
    )
      throw new Error("First-reply intake could not be disabled.");

    const activePresence = await tx
      .select()
      .from(localPresence)
      .where(
        and(
          eq(localPresence.worldId, world.id),
          eq(localPresence.npcId, npc[0]!.id),
          eq(localPresence.contextId, scene.id),
        ),
      );
    for (const presence of activePresence) {
      const revoked = await revokeHostSceneSpeechPolicy(tx, {
        worldId: world.id,
        npcId: npc[0]!.id,
        contextId: scene.id,
        presenceId: presence.id,
      });
      if (
        revoked.status !== "revoked" &&
        revoked.status !== "already_revoked" &&
        revoked.status !== "not_found"
      )
        throw new Error("First-reply host policy could not be disabled.");
    }
    return {
      event: "npc_first_reply_provision",
      status:
        intake.event === "pilot_policy_already_disabled"
          ? "already_disabled"
          : "disabled",
      worldKey: firstReplyWorldKey,
      canSend: false,
      readOnly: false,
    };
  });
}

export async function runFirstReplyProvisionCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
): Promise<FirstReplyProvisionResult> {
  // Validate all flags and isolated config BEFORE obtaining any DB connection.
  const initial = validateFirstReplyProvisionEnvironment(env, "preview");
  const mode = parseFirstReplyProvisionArguments(args, initial.route);
  const { route, userId } = validateFirstReplyProvisionEnvironment(env, mode);
  const client = connect(env);
  try {
    return await client.db.transaction(async (tx) => {
      if (mode === "preview")
        await tx.execute(sql.raw("set transaction read only"));
      await tx.execute(sql.raw("set local lock_timeout = '2s'"));
      await tx.execute(sql.raw("set local statement_timeout = '15s'"));
      await assertLocalDatabaseIdentity(tx);

      if (mode === "preview") {
        const found = await tx
          .select({ id: worlds.id })
          .from(worlds)
          .where(eq(worlds.key, firstReplyWorldKey))
          .limit(2);
        const routed = await tx
          .select({ id: discordContextMappings.id })
          .from(discordContextMappings)
          .where(
            and(
              eq(discordContextMappings.guildId, route.guildId),
              eq(discordContextMappings.channelId, route.channelId),
            ),
          )
          .limit(2);
        return {
          event: "npc_first_reply_provision",
          status:
            found.length === 0 && routed.length === 0
              ? "fresh_route_candidate"
              : "existing_review_required",
          worldKey: firstReplyWorldKey,
          canSend: false,
          readOnly: true,
        };
      }
      if (mode === "disable") return disableFirstReplyFixture(tx, route);
      if (!userId)
        throw new Error("A private human ID is required for first setup.");
      return prepareFirstReplyFixture(tx, route, userId);
    });
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runFirstReplyProvisionCommand(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      // Never output raw Discord IDs, player content, credentials or SQL.
      console.error(
        JSON.stringify({ event: "npc_first_reply_provision_failed_safely" }),
      );
      process.exitCode = 1;
    },
  );
}
