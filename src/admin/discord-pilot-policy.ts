import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { DatabaseClient } from "../db/client.js";
import { createDatabaseClient } from "../db/client.js";
import { contextIntakePolicyAudit } from "../db/schema/context-intake-policy-audit.js";
import { discordContextMappings } from "../db/schema/discord-context-mappings.js";
import { discordIdentities } from "../db/schema/discord-identities.js";
import { entities } from "../db/schema/entities.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { interactions } from "../db/schema/interactions.js";
import { responseDeliveries } from "../db/schema/response-deliveries.js";
import { worlds } from "../db/schema/worlds.js";
import { lockRouting } from "../domains/discord-mapping/discord-mapping.repository.js";
import type { DevFixtureRoute } from "./discord-dev-fixture.js";
import {
  pilotWorldKey,
  validatePilotFixtureEnvironment,
} from "./discord-pilot-fixture.js";
import { validatePilotPlayerEnvironment } from "./discord-pilot-player.js";

type Database = Omit<DatabaseClient["db"], "$client">;
export type PilotPolicyMode = "preview" | "enable" | "disable";
export type PilotPolicyRequest = {
  worldKey: string;
  route: DevFixtureRoute;
  mode: PilotPolicyMode;
  confirmedContextId?: string;
  testUserId?: string;
};

const databaseName = "living_world_gateway_dev";

export function parsePilotPolicyArguments(args: readonly string[]): {
  mode: PilotPolicyMode;
  confirmedContextId?: string;
} {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return { mode: "preview" };
  if (
    args.length === 7 &&
    (args[0] === "--enable" || args[0] === "--disable") &&
    args[1] === "--confirm-world" &&
    args[2] === pilotWorldKey &&
    args[3] === "--confirm-context" &&
    z.string().uuid().safeParse(args[4]).success &&
    args[5] === "--confirm-database" &&
    args[6] === databaseName
  )
    return {
      mode: args[0] === "--enable" ? "enable" : "disable",
      confirmedContextId: args[4],
    };
  throw new Error(
    "Policy changes require exact pilot world, context UUID and DEV database confirmation.",
  );
}

// Operator-only command. Do not import it into Discord runtime or expose it
// through HTTP/Discord/LLM handlers. The CLI fixes the world, route and database.
export async function reconcilePilotPolicy(
  database: Database,
  request: PilotPolicyRequest,
) {
  return database.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout='2s'`);
    await tx.execute(sql`set local statement_timeout='8s'`);

    const pilotWorlds = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.key, request.worldKey))
      .for("share");
    if (
      pilotWorlds.length !== 1 ||
      pilotWorlds[0]!.status !== "active" ||
      pilotWorlds[0]!.systemType !== "test"
    )
      throw new Error("Only an active synthetic pilot world is permitted.");
    const world = pilotWorlds[0]!;

    // Same advisory lock key as context mapping; concurrent first location
    // mappings cannot slip past a policy transition.
    await lockRouting(tx, [
      "location",
      request.route.guildId,
      request.route.channelId,
    ]);
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
      throw new Error("Pilot scene is not the approved isolated Discord route.");
    const context = contexts[0]!;
    if (
      request.mode !== "preview" &&
      request.confirmedContextId !== context.id
    )
      throw new Error("Confirmed pilot context does not match the scene.");

    const mappings = await tx
      .select()
      .from(discordContextMappings)
      .where(eq(discordContextMappings.worldId, world.id));
    const sameParent = await tx
      .select()
      .from(discordContextMappings)
      .where(
        and(
          eq(discordContextMappings.guildId, request.route.guildId),
          eq(discordContextMappings.channelId, request.route.channelId),
        ),
      );
    if (
      mappings.length !== 1 ||
      sameParent.length !== 1 ||
      mappings[0]!.id !== sameParent[0]!.id ||
      mappings[0]!.contextId !== context.id ||
      mappings[0]!.threadId !== request.route.threadId ||
      mappings[0]!.mappingType !== "scene" ||
      mappings[0]!.status !== "active" ||
      mappings[0]!.npcId !== null
    )
      throw new Error("Unexpected pilot route or cross-world mapping.");

    const identities = await tx
      .select()
      .from(discordIdentities)
      .where(eq(discordIdentities.worldId, world.id));
    if (identities.length > 1)
      throw new Error("Pilot must have no more than one identity.");
    const identity = identities[0];
    const priorAudits = await tx
      .select({ id: contextIntakePolicyAudit.id })
      .from(contextIntakePolicyAudit)
      .where(
        and(
          eq(contextIntakePolicyAudit.worldId, world.id),
          eq(contextIntakePolicyAudit.contextId, context.id),
        ),
      );

    const base = {
      worldId: world.id,
      contextId: context.id,
      policy: context.npcIntakePolicy,
      identityStatus: identity?.status ?? "absent",
      policyAuditEvents: priorAudits.length,
    };
    if (request.mode === "preview")
      return { event: "pilot_policy_preview", ...base };

    // The emergency disable path intentionally does not require a valid user
    // identity, clean interactions, or delivery state: it must fail closed.
    if (request.mode === "disable") {
      if (context.npcIntakePolicy === "disabled")
        return { event: "pilot_policy_already_disabled", ...base };
      if (context.npcIntakePolicy !== "mapped_players")
        throw new Error("Unrecognized pilot intake policy.");
      return transitionPolicy("disabled");
    }

    if (context.npcIntakePolicy !== "disabled")
      throw new Error("Pilot intake must be disabled before first enable.");
    if (priorAudits.length)
      throw new Error("Pilot was already activated; reuse requires review.");

    // This is a specific temporary human player's identity, not a generic
    // permanent user allowlist. Never echo the Discord User ID in the output.
    const playerEntities = await tx
      .select()
      .from(entities)
      .where(eq(entities.worldId, world.id));
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
      ) ||
      !identity ||
      identity.status !== "active" ||
      identity.discordUserId !== request.testUserId ||
      identity.entityId !== player[0]!.id ||
      identity.mappingType !== "player_character"
    )
      throw new Error("Pilot does not have exactly one approved active player.");

    const priorInteractions = await tx
      .select({ id: interactions.id })
      .from(interactions)
      .where(eq(interactions.worldId, world.id))
      .limit(1);
    const priorDeliveries = await tx
      .select({ id: responseDeliveries.id })
      .from(responseDeliveries)
      .where(eq(responseDeliveries.worldId, world.id))
      .limit(1);
    if (priorInteractions.length || priorDeliveries.length)
      throw new Error("A used pilot world cannot be first-enabled.");
    return transitionPolicy("mapped_players");

    async function transitionPolicy(target: "disabled" | "mapped_players") {
      await tx
        .update(interactionContexts)
        .set({ npcIntakePolicy: target, updatedAt: new Date() })
        .where(
          and(
            eq(interactionContexts.id, context.id),
            eq(interactionContexts.worldId, world.id),
          ),
        );
      const [audit] = await tx
        .insert(contextIntakePolicyAudit)
        .values({
          id: randomUUID(),
          worldId: world.id,
          contextId: context.id,
          previousPolicy: context.npcIntakePolicy,
          targetPolicy: target,
        })
        .returning();
      if (!audit) throw new Error("Pilot policy audit persistence failed.");
      return {
        event: "pilot_policy_changed",
        auditId: audit.id,
        worldId: world.id,
        contextId: context.id,
        previousPolicy: context.npcIntakePolicy,
        policy: target,
      };
    }
  });
}

export async function runPilotPolicyCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
) {
  const { mode, confirmedContextId } = parsePilotPolicyArguments(args);
  const route = validatePilotFixtureEnvironment(env);
  // Only the enable path needs the approved, privately stored human User ID;
  // emergency disable must still work if that local file is lost.
  const testUserId =
    mode === "enable" ? validatePilotPlayerEnvironment(env).userId : undefined;
  const client = connect(env);
  try {
    return await client.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        select current_database() as database, current_user as db_role,
          current_setting('server_version_num')::int as version,
          (select rolsuper from pg_roles where rolname=current_user) as superuser
      `);
      const row = result.rows[0];
      if (
        !row ||
        row.database !== databaseName ||
        row.db_role !== "lw_gateway_dev" ||
        typeof row.version !== "number" ||
        row.version < 170000 ||
        row.version >= 180000 ||
        row.superuser !== false
      )
        throw new Error("Pilot policy database identity is not approved.");
      return reconcilePilotPolicy(tx, {
        worldKey: pilotWorldKey,
        route,
        mode,
        confirmedContextId,
        testUserId,
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
  void runPilotPolicyCommand(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      // Do not expose Discord user IDs, SQL, credentials or raw DB errors.
      console.error(JSON.stringify({ event: "pilot_policy_failed_safely" }));
      process.exitCode = 1;
    },
  );
}
