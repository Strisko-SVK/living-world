import { pathToFileURL } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { worlds } from "../db/schema/worlds.js";
import { entities } from "../db/schema/entities.js";
import { npcState } from "../db/schema/npc-state.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { discordContextMappings } from "../db/schema/discord-context-mappings.js";
import { discordIdentities } from "../db/schema/discord-identities.js";
import { contextIntakePolicyAudit } from "../db/schema/context-intake-policy-audit.js";
import { localPresence } from "../db/schema/local-presence.js";
import { interactions } from "../db/schema/interactions.js";
import { responseDeliveries } from "../db/schema/response-deliveries.js";
import {
  npcE2eWorldKey,
  validateNpcE2eFixtureEnvironment,
} from "./discord-npc-e2e-fixture.js";
import { gatewaySmokeBotId } from "./discord-gateway-smoke.js";

const expectedDatabase = "living_world_gateway_dev";
const expectedRole = "lw_gateway_dev";
const snowflake = /^\d{17,20}$/u;

export type ReadinessFacts = {
  fixture: "missing" | "valid" | "conflict";
  route: "free" | "valid" | "conflict";
  routeRevision: boolean;
  policy: "disabled" | "mapped_players" | "other";
  playerMappings: number;
  activeTestPlayer: boolean;
  matchingPresence: number;
  presenceRecords: number;
  policyAudits: number;
  validActivationAudit: boolean;
  interactions: number;
  deliveries: number;
};

export type ReadinessStatus =
  | "fixture_missing"
  | "default_deny"
  | "migration_required"
  | "setup_required"
  | "ready_for_inbound"
  | "already_used"
  | "blocked";

// A status is evidence only, never authorization to apply, connect or send.
export function classifyNpcE2eReadiness(f: ReadinessFacts): ReadinessStatus {
  if (f.fixture === "conflict" || f.route === "conflict") return "blocked";
  if (f.fixture === "missing")
    return f.route === "free" ? "fixture_missing" : "blocked";
  if (f.route !== "valid") return "blocked";
  if (f.interactions > 0 || f.deliveries > 0) return "already_used";
  if (!f.routeRevision) return "migration_required";
  if (
    f.policy === "disabled" &&
    f.playerMappings === 0 &&
    f.presenceRecords === 0 &&
    f.policyAudits === 0
  )
    return "default_deny";
  if (
    f.policy === "mapped_players" &&
    f.playerMappings === 1 &&
    f.activeTestPlayer &&
    f.matchingPresence === 1 &&
    f.presenceRecords === 1 &&
    f.policyAudits === 1 &&
    f.validActivationAudit
  )
    return "ready_for_inbound";
  if (
    f.policy === "disabled" ||
    (f.policy === "mapped_players" &&
      f.playerMappings <= 1 &&
      f.presenceRecords <= 1 &&
      f.policyAudits <= 1)
  )
    return "setup_required";
  return "blocked";
}

export function parseNpcE2eReadinessArguments(args: readonly string[]): void {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return;
  throw new Error("This command is read-only; only --preview is supported.");
}

export async function runNpcE2eReadinessCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
) {
  parseNpcE2eReadinessArguments(args);
  const route = validateNpcE2eFixtureEnvironment(environment);
  const expectedPlayerId = environment.LW_NPC_E2E_TEST_USER_ID;
  if (
    expectedPlayerId !== undefined &&
    (!snowflake.test(expectedPlayerId) ||
      expectedPlayerId === gatewaySmokeBotId ||
      Object.values(route).includes(expectedPlayerId))
  )
    throw new Error("Invalid proposed NPC E2E test player.");
  const client = connect(environment);
  try {
    return await inspectNpcE2eReadiness(client.db, route, expectedPlayerId);
  } finally {
    await client.close();
  }
}

export async function inspectNpcE2eReadiness(
  db: DatabaseClient["db"],
  route: { guildId: string; channelId: string; threadId: string },
  expectedPlayerId?: string,
) {
  return db.transaction(async (tx) => {
    // First statement of the transaction: PostgreSQL enforces no writes,
    // including accidental future edits to this operator-only command.
    await tx.execute(sql.raw("set transaction read only"));
    await tx.execute(sql.raw("set local statement_timeout = '8s'"));
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
      throw new Error("The isolated DEV database identity is not approved.");

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
    const routeRevision = trigger.rows[0]?.installed === true;

    const reserved = await tx
      .select()
      .from(discordContextMappings)
      .where(
        and(
          eq(discordContextMappings.guildId, route.guildId),
          eq(discordContextMappings.channelId, route.channelId),
        ),
      );
    const candidates = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.key, npcE2eWorldKey));
    const missing: ReadinessFacts = {
      fixture: "missing",
      route: reserved.length ? "conflict" : "free",
      routeRevision,
      policy: "disabled",
      playerMappings: 0,
      activeTestPlayer: false,
      matchingPresence: 0,
      presenceRecords: 0,
      policyAudits: 0,
      validActivationAudit: false,
      interactions: 0,
      deliveries: 0,
    };
    if (candidates.length === 0)
      return {
        event: "npc_e2e_readiness",
        worldKey: npcE2eWorldKey,
        status: classifyNpcE2eReadiness(missing),
        routeRevision,
      };

    const world = candidates[0]!;
    const scenes = await tx
      .select()
      .from(interactionContexts)
      .where(eq(interactionContexts.worldId, world.id));
    const mappings = await tx
      .select()
      .from(discordContextMappings)
      .where(eq(discordContextMappings.worldId, world.id));
    const members = await tx
      .select()
      .from(entities)
      .where(eq(entities.worldId, world.id));
    const identities = await tx
      .select()
      .from(discordIdentities)
      .where(eq(discordIdentities.worldId, world.id));
    const grants = await tx
      .select()
      .from(localPresence)
      .where(eq(localPresence.worldId, world.id));
    const audit = await tx
      .select()
      .from(contextIntakePolicyAudit)
      .where(eq(contextIntakePolicyAudit.worldId, world.id));
    const stored = await tx
      .select({ id: interactions.id })
      .from(interactions)
      .where(eq(interactions.worldId, world.id));
    const deliveries = await tx
      .select({ id: responseDeliveries.id })
      .from(responseDeliveries)
      .where(eq(responseDeliveries.worldId, world.id));
    const scene = scenes[0];
    const mapping = mappings[0];
    const npc = members.filter(
      (row) =>
        row.entityType === "npc" &&
        row.canonicalName === "Sentinel-001" &&
        row.status === "active",
    );
    const players = members.filter(
      (row) =>
        row.entityType === "player_character" &&
        row.canonicalName === "Gateway Test Character" &&
        row.status === "active",
    );
    const states =
      npc.length === 1
        ? await tx
            .select()
            .from(npcState)
            .where(eq(npcState.npcId, npc[0]!.id))
        : [];
    const state = states[0];
    const fixtureValid =
      candidates.length === 1 &&
      world.status === "active" &&
      world.systemType === "test" &&
      scenes.length === 1 &&
      !!scene &&
      scene.status === "active" &&
      scene.contextType === "scene" &&
      scene.externalProvider === "discord" &&
      scene.externalGuildId === route.guildId &&
      scene.externalChannelId === route.channelId &&
      scene.externalThreadId === route.threadId &&
      !!scene.linkedLocationEntityId &&
      members.length === 3 &&
      npc.length === 1 &&
      players.length === 1 &&
      states.length === 1;
    const routeValid =
      reserved.length === 1 &&
      mappings.length === 1 &&
      !!mapping &&
      reserved[0]!.id === mapping.id &&
      mapping.worldId === world.id &&
      mapping.contextId === scene?.id &&
      mapping.guildId === route.guildId &&
      mapping.channelId === route.channelId &&
      mapping.threadId === route.threadId &&
      mapping.mappingType === "scene" &&
      mapping.status === "active" &&
      mapping.npcId === null;
    const validPlayers =
      !!expectedPlayerId &&
      identities.length === 1 &&
      identities[0]!.entityId === players[0]?.id &&
      identities[0]!.discordUserId === expectedPlayerId &&
      identities[0]!.mappingType === "player_character" &&
      identities[0]!.status === "active";
    const matchingPresence = grants.filter(
      (grant) =>
        grant.revokedAt === null &&
        grant.npcId === npc[0]?.id &&
        grant.contextId === scene?.id &&
        grant.locationId === scene?.linkedLocationEntityId &&
        state?.currentLocationId === grant.locationId &&
        state?.locationCertainty === "certain" &&
        state?.version === grant.stateVersion,
    ).length;
    const validActivationAudit =
      audit.length === 1 &&
      audit[0]!.contextId === scene?.id &&
      audit[0]!.previousPolicy === "disabled" &&
      audit[0]!.targetPolicy === "mapped_players";
    const facts: ReadinessFacts = {
      fixture: fixtureValid ? "valid" : "conflict",
      route: routeValid ? "valid" : "conflict",
      routeRevision,
      policy:
        scene?.npcIntakePolicy === "disabled" ||
        scene?.npcIntakePolicy === "mapped_players"
          ? scene.npcIntakePolicy
          : "other",
      playerMappings: identities.length,
      activeTestPlayer: validPlayers,
      matchingPresence,
      presenceRecords: grants.length,
      policyAudits: audit.length,
      validActivationAudit,
      interactions: stored.length,
      deliveries: deliveries.length,
    };
    return {
      event: "npc_e2e_readiness",
      worldKey: npcE2eWorldKey,
      status: classifyNpcE2eReadiness(facts),
      routeRevision,
      policy: facts.policy,
      playerMappings: facts.playerMappings,
      activePresence: matchingPresence,
      interactions: facts.interactions,
      deliveries: facts.deliveries,
    };
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runNpcE2eReadinessCommand(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      // No Discord IDs, human identities, tokens or SQL in operator errors.
      console.error(JSON.stringify({ event: "npc_e2e_readiness_failed_safely" }));
      process.exitCode = 1;
    },
  );
}
