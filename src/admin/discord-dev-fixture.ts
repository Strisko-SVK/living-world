import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { worlds } from "../db/schema/worlds.js";
import { entities } from "../db/schema/entities.js";
import { entityAliases } from "../db/schema/entity-aliases.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { discordContextMappings } from "../db/schema/discord-context-mappings.js";
import { discordIdentities } from "../db/schema/discord-identities.js";
import { localPresence } from "../db/schema/local-presence.js";
import { contextIntakePolicyAudit } from "../db/schema/context-intake-policy-audit.js";
import { npcCapabilities } from "../db/schema/npc-capabilities.js";
import { npcGameProfiles } from "../db/schema/npc-game-profiles.js";
import { interactions } from "../db/schema/interactions.js";
import { responseDeliveries } from "../db/schema/response-deliveries.js";
import { createWorld } from "../domains/world/world.repository.js";
import { createEntity } from "../domains/entity/entity.repository.js";
import { createNpc, getNpcWithState } from "../domains/npc/npc.repository.js";
import { addEntityAlias } from "../domains/entity/entity.repository.js";
import { normalizeAlias } from "../domains/entity/alias-normalizer.js";
import { createInteractionContext } from "../domains/interaction/interaction.repository.js";
import { mapDiscordContext } from "../domains/discord-mapping/discord-mapping.repository.js";

type Database = Omit<DatabaseClient["db"], "$client">;
const devDbName = "living_world_gateway_dev";
export const devWorldKey = "lw-dev-gateway-001";
const devWorldName = "Living World DEV - Gateway Lab";
const locationName = "Test Chamber A";
const npcName = "Sentinel-001";
const npcAlias = "Sentinel";
const playerName = "Gateway Test Character";
const routeSchema = z
  .object({
    guildId: z.string().regex(/^\d{17,20}$/u),
    channelId: z.string().regex(/^\d{17,20}$/u),
    threadId: z.string().regex(/^\d{17,20}$/u),
  })
  .strict();

export type DevFixtureRoute = z.infer<typeof routeSchema>;
export type DevFixtureResult = {
  status: "would_create" | "created" | "already_present";
  worldKey: string;
  worldId?: string;
  contextId?: string;
  npcId?: string;
};

// A CLI guard, not a substitute for a separately isolated database role.
// Evaluate before creating a connection; never echo the connection URL.
export function validateDevFixtureEnvironment(
  environment: NodeJS.ProcessEnv,
): DevFixtureRoute {
  if (
    environment.NODE_ENV === "production" ||
    environment.DISCORD_ENABLED === "true" ||
    environment.DISCORD_OUTBOUND_ENABLED === "true" ||
    (environment.LLM_PROVIDER ?? "disabled") !== "disabled"
  )
    throw new Error("DEV fixture requires disabled Discord, outbound and LLM.");
  const raw = environment.DATABASE_URL;
  if (!raw) throw new Error("DEV fixture requires a local isolated database.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DEV fixture database URL is invalid.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    decodeURIComponent(url.pathname) !== "/" + devDbName ||
    decodeURIComponent(url.username) !== "lw_gateway_dev" ||
    url.password.length === 0 ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("DEV fixture database target is not permitted.");
  const parsed = routeSchema.safeParse({
    guildId: environment.LW_DEV_GUILD_ID,
    channelId: environment.LW_DEV_PARENT_CHANNEL_ID,
    threadId: environment.LW_DEV_THREAD_ID,
  });
  if (!parsed.success)
    throw new Error("DEV fixture needs three valid Discord route IDs.");
  if (new Set(Object.values(parsed.data)).size !== 3)
    throw new Error("DEV fixture route IDs must be distinct.");
  return parsed.data;
}

export function parseDevFixtureArguments(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  if (
    args.length === 3 &&
    args[0] === "--apply" &&
    args[1] === "--confirm-database" &&
    args[2] === devDbName
  )
    return true;
  throw new Error(
    "Use preview (no arguments) or --apply --confirm-database living_world_gateway_dev.",
  );
}

function conflict(): never {
  throw new Error(
    "DEV fixture conflicts with existing records; no changes applied.",
  );
}

const baselineProfile = {
  identity: {
    name: npcName,
    species: "Synthetic",
    role: "Gateway test sentinel",
  },
  summary:
    "Synthetic offline integration-test character. No campaign knowledge.",
  personality: { traits: ["neutral"], values: [] as string[] },
};

function sameRoute(
  row: typeof discordContextMappings.$inferSelect,
  route: DevFixtureRoute,
) {
  return (
    row.guildId === route.guildId &&
    row.channelId === route.channelId &&
    row.threadId === route.threadId
  );
}

export async function provisionDevFixture(
  database: Database,
  routeInput: DevFixtureRoute,
  apply = false,
  worldKey = devWorldKey,
): Promise<DevFixtureResult> {
  const route = routeSchema.parse(routeInput);
  if (new Set(Object.values(route)).size !== 3) conflict();
  return database.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '8s'`);
    // Serializes concurrent first creations, before the world row exists.
    await tx.execute(sql`select pg_advisory_xact_lock(8202601102)`);
    // No parent-wide fallback or overlapping route, even in a foreign world.
    const routed = await tx
      .select()
      .from(discordContextMappings)
      .where(
        and(
          eq(discordContextMappings.guildId, route.guildId),
          eq(discordContextMappings.channelId, route.channelId),
        ),
      );
    const existing = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.key, worldKey))
      .limit(2);
    if (existing.length > 1) conflict();
    const world = existing[0];
    if (!world) {
      if (routed.length) conflict();
      if (!apply) return { status: "would_create", worldKey };
      const createdWorld = await createWorld(tx, {
        key: worldKey,
        name: devWorldName,
        systemType: "test",
        status: "active",
      });
      const location = await createEntity(tx, createdWorld.id, {
        entityType: "location",
        canonicalName: locationName,
      });
      const npc = await createNpc(tx, createdWorld.id, {
        canonicalName: npcName,
        simulationDepth: 0,
        narrativeWeight: 0,
        baselineProfile,
      });
      await addEntityAlias(tx, createdWorld.id, npc.entityId, {
        alias: npcAlias,
      });
      await createEntity(tx, createdWorld.id, {
        entityType: "player_character",
        canonicalName: playerName,
      });
      const context = await createInteractionContext(tx, createdWorld.id, {
        contextType: "scene",
        externalProvider: "discord",
        externalGuildId: route.guildId,
        externalChannelId: route.channelId,
        externalThreadId: route.threadId,
        linkedLocationEntityId: location.id,
      });
      await mapDiscordContext(tx, createdWorld.id, {
        contextId: context.id,
        ...route,
        mappingType: "scene",
      });
      return {
        status: "created",
        worldKey,
        worldId: createdWorld.id,
        contextId: context.id,
        npcId: npc.entityId,
      };
    }

    if (
      world.name !== devWorldName ||
      world.systemType !== "test" ||
      world.status !== "active" ||
      Object.keys(world.config).length !== 0
    )
      conflict();
    const worldEntities = await tx
      .select()
      .from(entities)
      .where(eq(entities.worldId, world.id));
    if (worldEntities.length !== 3) conflict();
    const locate = (name: string, type: string) => {
      const matches = worldEntities.filter(
        (row) =>
          row.canonicalName === name &&
          row.entityType === type &&
          row.status === "active",
      );
      if (matches.length !== 1) conflict();
      return matches[0]!;
    };
    const location = locate(locationName, "location");
    const npcEntity = locate(npcName, "npc");
    locate(playerName, "player_character");
    const npc = await getNpcWithState(tx, world.id, npcEntity.id);
    if (
      !npc ||
      npc.npc.lifecycleState !== "active" ||
      npc.npc.simulationDepth !== 0 ||
      npc.npc.narrativeWeight !== 0 ||
      npc.npc.canonProtected !== false ||
      npc.npc.templateVersion !== 1 ||
      npc.npc.profileVersion !== 1 ||
      !npc.state ||
      npc.state.version !== 1 ||
      npc.state.currentLocationId !== null ||
      npc.state.locationCertainty !== "unknown" ||
      !isDeepStrictEqual(npc.npc.baselineProfile, baselineProfile) ||
      !isDeepStrictEqual(npc.state.physicalState, {}) ||
      !isDeepStrictEqual(npc.state.emotionalState, {}) ||
      !isDeepStrictEqual(npc.state.materialState, {}) ||
      !isDeepStrictEqual(npc.state.availabilityState, {})
    )
      conflict();
    const aliases = await tx
      .select({ alias: entityAliases, entity: entities })
      .from(entityAliases)
      .innerJoin(entities, eq(entityAliases.entityId, entities.id))
      .where(eq(entities.worldId, world.id));
    if (
      aliases.length !== 1 ||
      aliases[0]!.alias.entityId !== npcEntity.id ||
      aliases[0]!.alias.alias !== npcAlias ||
      aliases[0]!.alias.normalizedAlias !== normalizeAlias(npcAlias)
    )
      conflict();
    // Reject unexpected capabilities or game-system data on the synthetic NPC.
    if (
      (
        await tx
          .select({ npcId: npcGameProfiles.npcId })
          .from(npcGameProfiles)
          .where(eq(npcGameProfiles.npcId, npcEntity.id))
          .limit(1)
      ).length
    )
      conflict();
    if (
      (
        await tx
          .select({ npcId: npcCapabilities.npcId })
          .from(npcCapabilities)
          .where(eq(npcCapabilities.npcId, npcEntity.id))
          .limit(1)
      ).length
    )
      conflict();
    const contexts = await tx
      .select()
      .from(interactionContexts)
      .where(eq(interactionContexts.worldId, world.id));
    if (contexts.length !== 1) conflict();
    const context = contexts[0]!;
    if (
      context.contextType !== "scene" ||
      context.status !== "active" ||
      context.npcIntakePolicy !== "disabled" ||
      context.metadata !== null ||
      context.linkedLocationEntityId !== location.id ||
      context.externalProvider !== "discord" ||
      context.externalGuildId !== route.guildId ||
      context.externalChannelId !== route.channelId ||
      context.externalThreadId !== route.threadId
    )
      conflict();
    const mappings = await tx
      .select()
      .from(discordContextMappings)
      .where(eq(discordContextMappings.worldId, world.id));
    if (
      mappings.length !== 1 ||
      routed.length !== 1 ||
      routed[0]!.id !== mappings[0]!.id ||
      !sameRoute(mappings[0]!, route) ||
      mappings[0]!.contextId !== context.id ||
      mappings[0]!.mappingType !== "scene" ||
      mappings[0]!.status !== "active" ||
      mappings[0]!.npcId !== null
    )
      conflict();
    // A reverted policy change is not a pristine, default-deny fixture.
    if (
      (
        await tx
          .select({ id: contextIntakePolicyAudit.id })
          .from(contextIntakePolicyAudit)
          .where(eq(contextIntakePolicyAudit.worldId, world.id))
          .limit(1)
      ).length
    )
      conflict();
    if (
      (
        await tx
          .select()
          .from(discordIdentities)
          .where(eq(discordIdentities.worldId, world.id))
          .limit(1)
      ).length
    )
      conflict();
    if (
      (
        await tx
          .select()
          .from(localPresence)
          .where(eq(localPresence.worldId, world.id))
          .limit(1)
      ).length
    )
      conflict();
    if (
      (
        await tx
          .select()
          .from(interactions)
          .where(eq(interactions.worldId, world.id))
          .limit(1)
      ).length
    )
      conflict();
    if (
      (
        await tx
          .select()
          .from(responseDeliveries)
          .where(eq(responseDeliveries.worldId, world.id))
          .limit(1)
      ).length
    )
      conflict();
    return {
      status: "already_present",
      worldKey,
      worldId: world.id,
      contextId: context.id,
      npcId: npcEntity.id,
    };
  });
}

// Deliberately no Discord client, webhook, generation, or cleanup side effects.
export async function runDevFixtureCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
) {
  const apply = parseDevFixtureArguments(args);
  const route = validateDevFixtureEnvironment(environment);
  const client = connect(environment);
  try {
    // Identity and provisioning must share the same PostgreSQL transaction:
    // a separate pool.query() might check a different backend connection.
    return await client.db.transaction(async (tx) => {
      const identity = await tx.execute(sql`
        select current_database() as database, current_user as db_role,
          current_setting('server_version_num')::int as version,
          (select rolsuper from pg_roles where rolname=current_user) as superuser
      `);
      const row = identity.rows[0];
      if (
        !row ||
        row.database !== devDbName ||
        row.version < 170000 ||
        row.version >= 180000 ||
        row.db_role !== "lw_gateway_dev" ||
        row.superuser !== false
      )
        throw new Error("DEV fixture database identity is not approved.");
      return provisionDevFixture(tx, route, apply);
    });
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runDevFixtureCommand(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      console.error(
        "DEV fixture failed safely; check local DB identity and fixture conflicts.",
      );
      process.exitCode = 1;
    },
  );
}
