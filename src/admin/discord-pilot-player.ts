import { pathToFileURL } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { createDatabaseClient } from "../db/client.js";
import { worlds } from "../db/schema/worlds.js";
import { entities } from "../db/schema/entities.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { discordContextMappings } from "../db/schema/discord-context-mappings.js";
import { discordIdentities } from "../db/schema/discord-identities.js";
import { interactions } from "../db/schema/interactions.js";
import { responseDeliveries } from "../db/schema/response-deliveries.js";
import {
  mapDiscordUserToEntity,
  deactivateDiscordUserMapping,
  lockRouting,
} from "../domains/discord-mapping/discord-mapping.repository.js";
import {
  pilotWorldKey,
  validatePilotFixtureEnvironment,
} from "./discord-pilot-fixture.js";
import type { DevFixtureRoute } from "./discord-dev-fixture.js";

type Database = Omit<DatabaseClient["db"], "$client">;
export type PilotPlayerMode = "preview" | "enroll" | "revoke";

const dbName = "living_world_gateway_dev";
const botUserId = "1566909036899868712";
const snowflake = /^\d{17,20}$/u;

export function validatePilotPlayerEnvironment(env: NodeJS.ProcessEnv): {
  route: DevFixtureRoute;
  userId: string;
} {
  const route = validatePilotFixtureEnvironment(env);
  const userId = env.LW_PILOT_TEST_USER_ID ?? "";
  if (
    !snowflake.test(userId) ||
    userId === botUserId ||
    Object.values(route).includes(userId) ||
    [env.LW_DEV_PARENT_CHANNEL_ID, env.LW_DEV_THREAD_ID].includes(userId)
  )
    throw new Error("Pilot test user must be an isolated human Discord ID.");
  return { route, userId };
}

export function parsePilotPlayerArguments(
  args: readonly string[],
): PilotPlayerMode {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return "preview";
  if (
    args.length === 5 &&
    (args[0] === "--enroll" || args[0] === "--revoke") &&
    args[1] === "--confirm-world" &&
    args[2] === pilotWorldKey &&
    args[3] === "--confirm-database" &&
    args[4] === dbName
  )
    return args[0] === "--enroll" ? "enroll" : "revoke";
  throw new Error(
    "Pilot player write requires exact world and DB confirmation.",
  );
}

export type PilotPlayerRequest = {
  worldKey: string;
  route: DevFixtureRoute;
  userId: string;
  mode: PilotPlayerMode;
};

// Pure DB operation with a synthetic-testable world key. Never call from an
// untrusted Discord callback: the CLI below fixes world/route/DB privileges.
export async function reconcilePilotPlayer(
  database: Database,
  request: PilotPlayerRequest,
) {
  if (!snowflake.test(request.userId) || request.userId === botUserId)
    throw new Error("Invalid pilot test user.");
  return database.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout='2s'`);
    await tx.execute(sql`set local statement_timeout='8s'`);
    const found = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.key, request.worldKey))
      .for("share");
    if (
      found.length !== 1 ||
      found[0]!.status !== "active" ||
      found[0]!.systemType !== "test"
    )
      throw new Error("Pilot world identity is not approved.");
    const world = found[0]!;

    const contexts = await tx
      .select()
      .from(interactionContexts)
      .where(eq(interactionContexts.worldId, world.id))
      .for(request.mode === "preview" ? "share" : "update");
    if (
      contexts.length !== 1 ||
      contexts[0]!.status !== "active" ||
      contexts[0]!.contextType !== "scene" ||
      contexts[0]!.externalProvider !== "discord" ||
      contexts[0]!.externalGuildId !== request.route.guildId ||
      contexts[0]!.externalChannelId !== request.route.channelId ||
      contexts[0]!.externalThreadId !== request.route.threadId
    )
      throw new Error("Pilot scene no longer matches approved route.");
    const context = contexts[0]!;

    const [worldRoutes, locationRoutes, playerEntities] = await Promise.all([
      tx
        .select()
        .from(discordContextMappings)
        .where(eq(discordContextMappings.worldId, world.id)),
      tx
        .select()
        .from(discordContextMappings)
        .where(
          and(
            eq(discordContextMappings.guildId, request.route.guildId),
            eq(discordContextMappings.channelId, request.route.channelId),
          ),
        ),
      tx.select().from(entities).where(eq(entities.worldId, world.id)),
    ]);
    const mapping = worldRoutes[0];
    if (
      worldRoutes.length !== 1 ||
      locationRoutes.length !== 1 ||
      locationRoutes[0]!.id !== mapping?.id ||
      !mapping ||
      mapping.contextId !== context.id ||
      mapping.threadId !== request.route.threadId ||
      mapping.mappingType !== "scene" ||
      mapping.status !== "active" ||
      mapping.npcId !== null
    )
      throw new Error("Pilot route mapping conflicts with another world.");

    const player = playerEntities.filter(
      (entity) =>
        entity.entityType === "player_character" &&
        entity.canonicalName === "Gateway Test Character" &&
        entity.status === "active",
    );
    if (
      playerEntities.length !== 3 ||
      player.length !== 1 ||
      !playerEntities.some(
        (entity) =>
          entity.entityType === "npc" &&
          entity.canonicalName === "Sentinel-001" &&
          entity.status === "active",
      )
    )
      throw new Error("Pilot player/NPC fixture is not approved.");

    // Shared advisory lock with the main identity mapping repository.
    // It also protects a first mapping when no DB row exists yet.
    await lockRouting(tx, ["identity", world.id, request.userId]);
    const existing = await tx
      .select()
      .from(discordIdentities)
      .where(eq(discordIdentities.worldId, world.id));
    if (
      existing.length > 1 ||
      existing.some(
        (row) =>
          row.discordUserId !== request.userId ||
          row.entityId !== player[0]!.id ||
          row.mappingType !== "player_character",
      )
    )
      throw new Error("Pilot already contains an unexpected identity.");
    const identity = existing[0];
    const base = {
      worldId: world.id,
      contextId: context.id,
      policy: context.npcIntakePolicy,
    };
    if (request.mode === "preview")
      return {
        event: "pilot_player_preview",
        ...base,
        identityStatus: identity?.status ?? "absent",
      };

    if (context.npcIntakePolicy !== "disabled")
      throw new Error("Disable pilot intake before changing a test identity.");

    if (request.mode === "enroll") {
      if (identity) {
        if (identity.status === "active")
          return { event: "pilot_player_already_enrolled", ...base };
        throw new Error(
          "Previously revoked pilot identity needs manual review.",
        );
      }
      const [priorInteractions, priorDeliveries] = await Promise.all([
        tx
          .select({ id: interactions.id })
          .from(interactions)
          .where(eq(interactions.worldId, world.id))
          .limit(1),
        tx
          .select({ id: responseDeliveries.id })
          .from(responseDeliveries)
          .where(eq(responseDeliveries.worldId, world.id))
          .limit(1),
      ]);
      if (priorInteractions.length || priorDeliveries.length)
        throw new Error("Cannot enroll a player in a used pilot world.");
      const created = await mapDiscordUserToEntity(tx, world.id, {
        discordUserId: request.userId,
        entityId: player[0]!.id,
        mappingType: "player_character",
      });
      return { event: "pilot_player_enrolled", ...base, mappingId: created.id };
    }
    if (!identity || identity.status === "inactive")
      return { event: "pilot_player_already_revoked", ...base };

    const revoked = await deactivateDiscordUserMapping(
      tx,
      world.id,
      identity.id,
    );
    if (!revoked || revoked.status !== "inactive")
      throw new Error("Pilot player revocation was not confirmed.");
    return { event: "pilot_player_revoked", ...base, mappingId: revoked.id };
  });
}

export async function runPilotPlayerCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
) {
  const mode = parsePilotPlayerArguments(args);
  const { route, userId } = validatePilotPlayerEnvironment(env);
  const client = connect(env);
  try {
    return await client.db.transaction(async (tx) => {
      const identity = await tx.execute(sql`
        select current_database() as database, current_user as db_role,
          current_setting('server_version_num')::int as version,
          (select rolsuper from pg_roles where rolname=current_user) as superuser
      `);
      const row = identity.rows[0];
      if (
        !row ||
        row.database !== dbName ||
        row.db_role !== "lw_gateway_dev" ||
        typeof row.version !== "number" ||
        row.version < 170000 ||
        row.version >= 180000 ||
        row.superuser !== false
      )
        throw new Error("Pilot enrollment DB identity is not approved.");
      return reconcilePilotPlayer(tx, {
        worldKey: pilotWorldKey,
        route,
        userId,
        mode,
      });
    });
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runPilotPlayerCommand(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      // No Discord user ID, token, SQL/DB URL or campaign text in CLI errors.
      console.error(JSON.stringify({ event: "pilot_player_failed_safely" }));
      process.exitCode = 1;
    },
  );
}
