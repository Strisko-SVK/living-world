import { pathToFileURL } from "node:url";
import { Client, GatewayIntentBits } from "discord.js";
import { and, eq, sql } from "drizzle-orm";

import { createDiscordPersistence } from "../adapters/discord/persistence.js";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { contextIntakePolicyAudit } from "../db/schema/context-intake-policy-audit.js";
import { discordContextMappings } from "../db/schema/discord-context-mappings.js";
import { discordIdentities } from "../db/schema/discord-identities.js";
import { entities } from "../db/schema/entities.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { interactions } from "../db/schema/interactions.js";
import { localPresence } from "../db/schema/local-presence.js";
import { npcState } from "../db/schema/npc-state.js";
import { responseDeliveries } from "../db/schema/response-deliveries.js";
import { worlds } from "../db/schema/worlds.js";
import {
  createDiscordIntake,
  type IncomingMessage,
} from "../intake/discord-intake.js";
import { discordMessageCreatedAt } from "../intake/discord-snowflake.js";
import { validateNpcE2eActivationEnvironment } from "./discord-npc-e2e-activation.js";
import { npcE2eWorldKey } from "./discord-npc-e2e-fixture.js";
import { inspectNpcE2eReadiness } from "./discord-npc-e2e-readiness.js";
import {
  connectOnePilotMessage,
  type PilotInboundConfig,
  type PilotInboundDiagnostic,
} from "./discord-pilot-gateway.js";
import { validateGatewaySmokeConfig } from "./discord-gateway-smoke.js";

// New, independently authorized one-shot target. All IDs are synthetic DEV
// records already created by the owner; the human ID and token remain private.
export const npcE2eInboundTarget = {
  worldId: "e551f23e-2393-4726-af97-828ef3587625",
  contextId: "bd921a22-7abc-4c08-ae55-bd7050d9c4f7",
  npcId: "3f066c82-eb7d-45aa-92dd-08d171a7dc2c",
  playerMappingId: "776190c1-903f-4a73-a9b3-1c799c4043c7",
  presenceId: "1ab9b246-d293-4e4b-95ef-6239d72645b7",
  policyAuditId: "c87c3ee2-1e2b-438a-9a36-b60299db615b",
} as const;

export const npcE2eInboundRoute = {
  guildId: "1566911648701223053",
  parentId: "1568349822505717830",
  threadId: "1568350458026786886",
} as const;

const expectedDb = "living_world_gateway_dev";
const expectedRole = "lw_gateway_dev";
const eventText = "[Sentinel] Report readiness.";

export type NpcE2eInboundConfig = PilotInboundConfig & {
  presenceId: string;
};

export function validateNpcE2eInboundEnvironment(
  env: NodeJS.ProcessEnv,
): NpcE2eInboundConfig {
  // The existing gateway-smoke validator authenticates a private DEV bot
  // token, exact bot identity, and the disabled normal runtime.
  const bot = validateGatewaySmokeConfig(env);
  const { route, userId } = validateNpcE2eActivationEnvironment(
    env,
    "activate",
  );
  if (
    bot.guildId !== npcE2eInboundRoute.guildId ||
    route.guildId !== npcE2eInboundRoute.guildId ||
    route.channelId !== npcE2eInboundRoute.parentId ||
    route.threadId !== npcE2eInboundRoute.threadId ||
    !userId
  )
    throw new Error(
      "NPC E2E inbound route or private test player is not approved.",
    );
  return {
    botId: bot.botId,
    token: bot.token,
    guildId: route.guildId,
    parentId: route.channelId,
    threadId: route.threadId,
    playerId: userId,
    scope: {
      worldKey: npcE2eWorldKey,
      worldId: npcE2eInboundTarget.worldId,
      contextId: npcE2eInboundTarget.contextId,
      npcId: npcE2eInboundTarget.npcId,
      playerMappingId: npcE2eInboundTarget.playerMappingId,
      policyAuditId: npcE2eInboundTarget.policyAuditId,
    },
    presenceId: npcE2eInboundTarget.presenceId,
  };
}

export type NpcE2eInboundMode =
  | "preflight"
  | "preflight_message_content"
  | "connect"
  | "connect_message_content";

// Explicit opt-in only. MESSAGE_CONTENT increases Discord data visible to
// the SDK; never request it in the legacy pilot or regular runtime.
export function npcE2eGatewayIntents(privileged: boolean): GatewayIntentBits[] {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  if (privileged) intents.push(GatewayIntentBits.MessageContent);
  return intents;
}

export function parseNpcE2eInboundArguments(
  args: readonly string[],
): NpcE2eInboundMode {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preflight"))
    return "preflight";
  if (
    args.length === 2 &&
    args[0] === "--preflight" &&
    args[1] === "--check-message-content-intent"
  )
    return "preflight_message_content";
  const privileged =
    args.length === 18 &&
    args[17] === "--confirm-message-content-intent";
  if (
    (args.length === 17 || privileged) &&
    args[0] === "--connect" &&
    args[1] === "--confirm-world" &&
    args[2] === npcE2eWorldKey &&
    args[3] === "--confirm-world-id" &&
    args[4] === npcE2eInboundTarget.worldId &&
    args[5] === "--confirm-context" &&
    args[6] === npcE2eInboundTarget.contextId &&
    args[7] === "--confirm-guild" &&
    args[8] === npcE2eInboundRoute.guildId &&
    args[9] === "--confirm-parent" &&
    args[10] === npcE2eInboundRoute.parentId &&
    args[11] === "--confirm-thread" &&
    args[12] === npcE2eInboundRoute.threadId &&
    args[13] === "--confirm-database" &&
    args[14] === expectedDb &&
    args[15] === "--inbound-only" &&
    args[16] === "--one-message"
  )
    return privileged ? "connect_message_content" : "connect";
  throw new Error(
    "Live NPC E2E inbound requires all exact one-message confirmations.",
  );
}

export function requireNpcE2ePrivilegedGate(
  mode: NpcE2eInboundMode,
  env: NodeJS.ProcessEnv,
): void {
  if (
    (mode === "connect_message_content" ||
      mode === "preflight_message_content") &&
    env.LW_NPC_E2E_PRIVILEGED_CONTENT_APPROVED !== "true"
  )
    throw new Error(
      "Separate owner privileged-intent authorization is required.",
    );
}

// Only SDK-authenticated snowflakes from this explicitly armed session can
// consume the one-shot pilot. This does not authenticate arbitrary input.
export function isFreshNpcE2eSource(
  sourceMessageId: string,
  armedAt: number,
  now: number,
): boolean {
  const sourceMs = discordMessageCreatedAt(sourceMessageId);
  return sourceMs !== null && sourceMs >= armedAt && sourceMs <= now + 30_000;
}

export async function verifyNpcE2eInboundDatabase(
  db: DatabaseClient["db"],
  config: NpcE2eInboundConfig,
  phase: "before" | "after",
  sourceMessageId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // PostgreSQL explicitly prevents writes throughout verification.
    await tx.execute(sql.raw("set transaction read only"));
    await tx.execute(sql.raw("set local statement_timeout = '8s'"));
    const identity = await tx.execute(
      sql.raw(
        "select current_database() as database, current_user as role, " +
          "current_setting('server_version_num')::int as version, " +
          "(select rolsuper from pg_roles where rolname=current_user) as superuser, " +
          "(select rolcreatedb from pg_roles where rolname=current_user) as createdb, " +
          "(select rolcreaterole from pg_roles where rolname=current_user) as createrole",
      ),
    );
    const role = identity.rows[0];
    if (
      !role ||
      role.database !== expectedDb ||
      role.role !== expectedRole ||
      typeof role.version !== "number" ||
      role.version < 170000 ||
      role.version >= 180000 ||
      role.superuser !== false ||
      role.createdb !== false ||
      role.createrole !== false
    )
      throw new Error("Isolated owner DEV database identity is not approved.");

    await verifyNpcE2eInboundFacts(tx, config, phase, sourceMessageId);
  });
}

type Database = Omit<DatabaseClient["db"], "$client">;

// The DB business facts are split from the read-only role guard to allow
// rollback-only PostgreSQL integration tests using a synthetic world key.
// The operator entrypoint ALWAYS calls the guarded verifier above.
export async function verifyNpcE2eInboundFacts(
  tx: Database,
  config: NpcE2eInboundConfig,
  phase: "before" | "after",
  sourceMessageId?: string,
): Promise<void> {
  const scope = config.scope;
  const found = await tx
    .select()
    .from(worlds)
    .where(eq(worlds.key, scope.worldKey));
  if (
    found.length !== 1 ||
    found[0]!.id !== scope.worldId ||
    found[0]!.status !== "active" ||
    found[0]!.systemType !== "test"
  )
    throw new Error("NPC E2E world scope is not approved.");

  const scenes = await tx
    .select()
    .from(interactionContexts)
    .where(eq(interactionContexts.worldId, scope.worldId));
  const scene = scenes[0];
  if (
    scenes.length !== 1 ||
    !scene ||
    scene.id !== scope.contextId ||
    scene.contextType !== "scene" ||
    scene.status !== "active" ||
    scene.npcIntakePolicy !== "mapped_players" ||
    scene.externalProvider !== "discord" ||
    scene.externalGuildId !== config.guildId ||
    scene.externalChannelId !== config.parentId ||
    scene.externalThreadId !== config.threadId ||
    !scene.linkedLocationEntityId
  )
    throw new Error("NPC E2E mapped-player scene is not approved.");

  const routes = await tx
    .select()
    .from(discordContextMappings)
    .where(
      and(
        eq(discordContextMappings.guildId, config.guildId),
        eq(discordContextMappings.channelId, config.parentId),
      ),
    );
  const route = routes[0];
  if (
    routes.length !== 1 ||
    !route ||
    route.worldId !== scope.worldId ||
    route.contextId !== scope.contextId ||
    route.guildId !== config.guildId ||
    route.channelId !== config.parentId ||
    route.threadId !== config.threadId ||
    route.mappingType !== "scene" ||
    route.status !== "active" ||
    route.npcId !== null
  )
    throw new Error("NPC E2E transport route is not isolated.");

  const members = await tx
    .select()
    .from(entities)
    .where(eq(entities.worldId, scope.worldId));
  const players = members.filter(
    (x) =>
      x.entityType === "player_character" &&
      x.canonicalName === "Gateway Test Character" &&
      x.status === "active",
  );
  const npc = members.filter(
    (x) =>
      x.id === scope.npcId &&
      x.entityType === "npc" &&
      x.canonicalName === "Sentinel-001" &&
      x.status === "active",
  );
  const identities = await tx
    .select()
    .from(discordIdentities)
    .where(eq(discordIdentities.worldId, scope.worldId));
  const human = identities[0];
  if (
    members.length !== 3 ||
    npc.length !== 1 ||
    players.length !== 1 ||
    identities.length !== 1 ||
    !human ||
    human.id !== scope.playerMappingId ||
    human.discordUserId !== config.playerId ||
    human.entityId !== players[0]!.id ||
    human.mappingType !== "player_character" ||
    human.status !== "active"
  )
    throw new Error("NPC E2E owner test player or NPC identity differs.");

  const states = await tx
    .select()
    .from(npcState)
    .where(eq(npcState.npcId, scope.npcId));
  const state = states[0];
  const grants = await tx
    .select()
    .from(localPresence)
    .where(eq(localPresence.worldId, scope.worldId));
  const grant = grants[0];
  if (
    states.length !== 1 ||
    !state ||
    state.currentLocationId !== scene.linkedLocationEntityId ||
    state.locationCertainty !== "certain" ||
    grants.length !== 1 ||
    !grant ||
    grant.id !== config.presenceId ||
    grant.revokedAt !== null ||
    grant.worldId !== scope.worldId ||
    grant.contextId !== scope.contextId ||
    grant.npcId !== scope.npcId ||
    grant.locationId !== scene.linkedLocationEntityId ||
    grant.stateVersion !== state.version
  )
    throw new Error("Trusted Sentinel local presence is not valid.");

  const audits = await tx
    .select()
    .from(contextIntakePolicyAudit)
    .where(eq(contextIntakePolicyAudit.worldId, scope.worldId));
  const audit = audits[0];
  if (
    audits.length !== 1 ||
    !audit ||
    audit.id !== scope.policyAuditId ||
    audit.contextId !== scope.contextId ||
    audit.previousPolicy !== "disabled" ||
    audit.targetPolicy !== "mapped_players"
  )
    throw new Error("NPC E2E activation audit has unexpected history.");

  const deliveries = await tx
    .select()
    .from(responseDeliveries)
    .where(eq(responseDeliveries.worldId, scope.worldId));
  const records = await tx
    .select()
    .from(interactions)
    .where(eq(interactions.worldId, scope.worldId));
  if (deliveries.length !== 0)
    throw new Error("NPC E2E world unexpectedly contains outbound deliveries.");
  if (phase === "before") {
    if (records.length !== 0 || sourceMessageId)
      throw new Error("NPC E2E one-shot inbound world has already been used.");
    return;
  }

  const interaction = records[0];
  const eventMs = discordMessageCreatedAt(sourceMessageId ?? null);
  if (
    !sourceMessageId ||
    !eventMs ||
    eventMs < grant.issuedAt.getTime() ||
    eventMs < audit.createdAt.getTime() ||
    eventMs < route.updatedAt.getTime() ||
    records.length !== 1 ||
    !interaction ||
    interaction.contextId !== scope.contextId ||
    interaction.npcId !== scope.npcId ||
    interaction.speakerEntityId !== players[0]!.id ||
    interaction.sourceProvider !== "discord" ||
    interaction.sourceMessageId !== sourceMessageId ||
    interaction.sourceGuildId !== config.guildId ||
    interaction.sourceChannelId !== config.parentId ||
    interaction.sourceThreadId !== config.threadId ||
    interaction.sourceMappingId !== route.id ||
    interaction.status !== "received" ||
    interaction.communicationMode !== "unknown" ||
    interaction.localPresenceId !== null ||
    (interaction.requestText !== "<@" + config.botId + "> " + eventText &&
      interaction.requestText !== "<@!" + config.botId + "> " + eventText) ||
    interaction.responseText !== null ||
    interaction.responseClaimId !== null ||
    interaction.responseClaimedAt !== null ||
    interaction.responseDispatchedAt !== null ||
    interaction.responsePromptVersion !== null ||
    interaction.responseGenerationOutcome !== null ||
    interaction.responseMessageId !== null ||
    interaction.respondedAt !== null ||
    interaction.completedAt !== null
  )
    throw new Error("NPC E2E did not persist exactly one inert inbound event.");
}

export async function runNpcE2eInboundCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
): Promise<{ event: string }> {
  const mode = parseNpcE2eInboundArguments(args);
  requireNpcE2ePrivilegedGate(mode, environment);
  const config = validateNpcE2eInboundEnvironment(environment);
  const route = {
    guildId: config.guildId,
    channelId: config.parentId,
    threadId: config.threadId,
  };
  const client = connect(environment);
  try {
    const readiness = await inspectNpcE2eReadiness(
      client.db,
      route,
      config.playerId,
    );
    if (readiness.status !== "ready_for_inbound")
      throw new Error(
        "NPC E2E must pass the read-only ready_for_inbound gate.",
      );
    await verifyNpcE2eInboundDatabase(client.db, config, "before");
    if (mode === "preflight" || mode === "preflight_message_content")
      return {
        event:
          mode === "preflight_message_content"
            ? "npc_e2e_message_content_preflight_valid"
            : "npc_e2e_inbound_preflight_valid",
      };

    // Source time is derived ONLY from an actual discord.js Gateway Message ID.
    // A queued/replayed message from before arming cannot consume this pilot.
    const armedAt = Date.now();
    const intake = createDiscordIntake(createDiscordPersistence(client.db));
    const reported = new Set<string>();
    const diagnose: PilotInboundDiagnostic = (stage) => {
      // Only the fixed, vetted stage labels leave the process. Never print
      // a Discord ID, user content, bot token, raw SQL or SDK exception.
      if (reported.has(stage)) return;
      reported.add(stage);
      console.info(
        JSON.stringify({ event: "npc_e2e_inbound_diagnostic", stage }),
      );
    };
    // Reuse Step 14's *tested transport only* with a fresh, independently
    // verified config. No Step 14 DB verifier, world, event or route is reused.
    // Preserve the previously tested unprivileged transport by default.
    // Only the isolated opt-in creates a client requesting MessageContent.
    const privileged = mode === "connect_message_content";
    const gatewayClient = privileged
      ? new Client({ intents: npcE2eGatewayIntents(true) })
      : undefined;
    if (privileged)
      console.info(
        JSON.stringify({ event: "npc_e2e_privileged_intent_requested" }),
      );
    await connectOnePilotMessage(
      config,
      async (message: IncomingMessage, botId: string) => {
        if (!isFreshNpcE2eSource(message.sourceMessageId, armedAt, Date.now()))
          return "stale";
        return intake(message, botId);
      },
      (sourceMessageId) =>
        verifyNpcE2eInboundDatabase(
          client.db,
          config,
          "after",
          sourceMessageId,
        ),
      gatewayClient,
      90_000,
      diagnose,
    );
    return { event: "npc_e2e_inbound_complete" };
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runNpcE2eInboundCommand(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      // Never log the human user ID, token, message text or raw SQL errors.
      console.error(JSON.stringify({ event: "npc_e2e_inbound_failed_safely" }));
      process.exitCode = 1;
    },
  );
}
