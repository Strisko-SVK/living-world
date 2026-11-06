import { pathToFileURL } from "node:url";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  type Message,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";

import { createDiscordPersistence } from "../adapters/discord/persistence.js";
import {
  normalizeDiscordMessage,
  type DiscordNormalizationRejection,
} from "../adapters/discord/message.js";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { contextIntakePolicyAudit } from "../db/schema/context-intake-policy-audit.js";
import { discordContextMappings } from "../db/schema/discord-context-mappings.js";
import { discordIdentities } from "../db/schema/discord-identities.js";
import { entities } from "../db/schema/entities.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { interactions } from "../db/schema/interactions.js";
import { localPresence } from "../db/schema/local-presence.js";
import { responseDeliveries } from "../db/schema/response-deliveries.js";
import { worlds } from "../db/schema/worlds.js";
import {
  createDiscordIntake,
  type IncomingMessage,
} from "../intake/discord-intake.js";
import { parseDiscordTrigger } from "../intake/discord-trigger.js";
import { validateGatewaySmokeConfig } from "./discord-gateway-smoke.js";
import { pilotWorldKey } from "./discord-pilot-fixture.js";
import { validatePilotPlayerEnvironment } from "./discord-pilot-player.js";

export type PilotInboundScope = {
  worldKey: string;
  worldId: string;
  contextId: string;
  npcId: string;
  playerMappingId: string;
  policyAuditId: string;
  originalWorldId?: string;
};

export type PilotInboundConfig = {
  botId: string;
  token: string;
  guildId: string;
  parentId: string;
  threadId: string;
  playerId: string;
  scope: PilotInboundScope;
};

export const pilotInboundScope: PilotInboundScope = {
  worldKey: pilotWorldKey,
  worldId: "585b48b9-9160-4366-9312-455c39551302",
  contextId: "3608a56c-2597-4df9-b749-b37b7d7cdace",
  npcId: "c3478581-b6fb-478c-85d0-9c0b3868ea3c",
  playerMappingId: "7f4d41ee-82fc-4694-aa79-098faf455413",
  policyAuditId: "2b95f215-1a22-4d25-9f62-fe15341d7af6",
  originalWorldId: "abfc527c-f5db-4294-8452-7eeb1ad7829a",
};

const targetGuildId = "1566911648701223053";
const targetParentId = "1567604837309350030";
const targetThreadId = "1567605016603271208";
const expectedDb = "living_world_gateway_dev";
const expectedRole = "lw_gateway_dev";

export function validatePilotInboundEnvironment(
  env: NodeJS.ProcessEnv,
): PilotInboundConfig {
  // Reuse Step 9's exact bot/token, loopback database and disabled-runtime
  // validation, plus Step 12's private human and isolated pilot route check.
  const smoke = validateGatewaySmokeConfig(env);
  const { route, userId } = validatePilotPlayerEnvironment(env);
  if (
    smoke.guildId !== targetGuildId ||
    route.guildId !== targetGuildId ||
    route.channelId !== targetParentId ||
    route.threadId !== targetThreadId
  )
    throw new Error("The isolated pilot Discord route does not match.");
  return {
    botId: smoke.botId,
    token: smoke.token,
    guildId: route.guildId,
    parentId: route.channelId,
    threadId: route.threadId,
    playerId: userId,
    scope: pilotInboundScope,
  };
}

export function parsePilotInboundArguments(
  args: readonly string[],
): "preflight" | "connect" {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preflight"))
    return "preflight";
  if (
    args.length === 11 &&
    args[0] === "--connect" &&
    args[1] === "--confirm-world" &&
    args[2] === pilotWorldKey &&
    args[3] === "--confirm-context" &&
    args[4] === pilotInboundScope.contextId &&
    args[5] === "--confirm-guild" &&
    args[6] === targetGuildId &&
    args[7] === "--confirm-database" &&
    args[8] === expectedDb &&
    args[9] === "--inbound-only" &&
    args[10] === "--one-message"
  )
    return "connect";
  throw new Error(
    "A live pilot session requires exact one-message confirmations.",
  );
}

// Diagnostic signals are fixed categories only: no player IDs, content,
// message IDs, channel IDs, token, exception messages or SQL are emitted.
export type PilotInboundDiagnosticStage =
  | "target_thread_event_seen"
  | "thread_shape_rejected"
  | "sender_or_kind_rejected"
  | "message_normalization_rejected"
  | "bot_mention_metadata_present"
  | "bot_mention_metadata_absent"
  | "bot_mention_metadata_unavailable"
  | `normalization_${DiscordNormalizationRejection}`
  | "mention_rejected"
  | "exact_text_rejected"
  | "alias_rejected"
  | "message_matched"
  | "intake_accepted"
  | "intake_rejected"
  | "intake_failed"
  | "post_write_audit_pass"
  | "post_write_audit_failed"
  | "timeout_without_match"
  | "timeout_during_processing"
  | "gateway_interrupted"
  | "operator_interrupted";

export type PilotInboundDiagnostic = (
  stage: PilotInboundDiagnosticStage,
) => void;

export function pickPilotInboundMessage(
  message: Message,
  config: PilotInboundConfig,
  diagnose?: PilotInboundDiagnostic,
): IncomingMessage | null {
  // Never inspect/log out-of-scope messages. Only record a fixed category for
  // Gateway events with the expected guild and thread channel ID.
  if (
    message.guildId !== config.guildId ||
    message.channelId !== config.threadId
  )
    return null;
  diagnose?.("target_thread_event_seen");

  if (
    !message.channel.isThread() ||
    message.channel.parentId !== config.parentId ||
    message.channel.type !== ChannelType.PublicThread
  ) {
    diagnose?.("thread_shape_rejected");
    return null;
  }
  if (
    message.partial ||
    message.author.bot ||
    message.author.id !== config.playerId ||
    !!message.webhookId ||
    message.system ||
    message.type !== MessageType.Default
  ) {
    diagnose?.("sender_or_kind_rejected");
    return null;
  }
  const normalized = normalizeDiscordMessage(message, (reason) => {
    // When content is withheld, the SDK mention collection is independent
    // metadata. Classify the target bot mention without printing IDs or text.
    if (reason === "content_unavailable") {
      const users = message.mentions?.users;
      diagnose?.(
        !users || typeof users.has !== "function"
          ? "bot_mention_metadata_unavailable"
          : users.has(config.botId)
            ? "bot_mention_metadata_present"
            : "bot_mention_metadata_absent",
      );
    }
    diagnose?.(`normalization_${reason}`);
  });
  if (!normalized) {
    diagnose?.("message_normalization_rejected");
    return null;
  }
  if (
    normalized.mentionedUserIds.length !== 1 ||
    normalized.mentionedUserIds[0] !== config.botId
  ) {
    diagnose?.("mention_rejected");
    return null;
  }
  const targetText = "<@" + config.botId + "> [Sentinel] Report readiness.";
  const literalText = normalized.content.replace(/^<@!(\d+)>/u, "<@$1>");
  if (literalText !== targetText) {
    diagnose?.("exact_text_rejected");
    return null;
  }
  const trigger = parseDiscordTrigger(
    normalized.content,
    config.botId,
    normalized.mentionedUserIds,
  );
  if (trigger?.alias !== "sentinel") {
    diagnose?.("alias_rejected");
    return null;
  }
  diagnose?.("message_matched");
  return normalized;
}

// Read-only, transactionally consistent inspection. This rejects a reused or
// already-consumed pilot, arbitrary identifiers and response/delivery drift.
export async function verifyPilotInboundDatabase(
  db: DatabaseClient["db"],
  config: PilotInboundConfig,
  phase: "before" | "after",
  sourceMessageId?: string,
): Promise<void> {
  const scope = config.scope;
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw("set transaction read only"));
    await tx.execute(sql.raw("set local statement_timeout = '8s'"));

    const foundWorlds = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.key, scope.worldKey));
    if (
      foundWorlds.length !== 1 ||
      foundWorlds[0]!.id !== scope.worldId ||
      foundWorlds[0]!.status !== "active" ||
      foundWorlds[0]!.systemType !== "test"
    )
      throw new Error("Pilot world is not the confirmed synthetic world.");

    const contexts = await tx
      .select()
      .from(interactionContexts)
      .where(eq(interactionContexts.worldId, scope.worldId));
    const scene = contexts[0];
    if (
      contexts.length !== 1 ||
      !scene ||
      scene.id !== scope.contextId ||
      scene.status !== "active" ||
      scene.contextType !== "scene" ||
      scene.npcIntakePolicy !== "mapped_players" ||
      scene.externalProvider !== "discord" ||
      scene.externalGuildId !== config.guildId ||
      scene.externalChannelId !== config.parentId ||
      scene.externalThreadId !== config.threadId
    )
      throw new Error("Pilot scene is not approved for mapped-player intake.");

    const routes = await tx
      .select()
      .from(discordContextMappings)
      .where(eq(discordContextMappings.worldId, scope.worldId));
    const sharedParent = await tx
      .select()
      .from(discordContextMappings)
      .where(
        and(
          eq(discordContextMappings.guildId, config.guildId),
          eq(discordContextMappings.channelId, config.parentId),
        ),
      );
    if (
      routes.length !== 1 ||
      sharedParent.length !== 1 ||
      routes[0]!.id !== sharedParent[0]!.id ||
      routes[0]!.contextId !== scope.contextId ||
      routes[0]!.threadId !== config.threadId ||
      routes[0]!.status !== "active" ||
      routes[0]!.mappingType !== "scene" ||
      routes[0]!.npcId !== null
    )
      throw new Error("Pilot route is not isolated.");

    const identities = await tx
      .select()
      .from(discordIdentities)
      .where(eq(discordIdentities.worldId, scope.worldId));
    const identity = identities[0];
    const members = await tx
      .select()
      .from(entities)
      .where(eq(entities.worldId, scope.worldId));
    const player = members.filter(
      (x) =>
        x.entityType === "player_character" &&
        x.canonicalName === "Gateway Test Character" &&
        x.status === "active",
    );
    if (
      identities.length !== 1 ||
      !identity ||
      identity.id !== scope.playerMappingId ||
      identity.discordUserId !== config.playerId ||
      identity.mappingType !== "player_character" ||
      identity.status !== "active" ||
      members.length !== 3 ||
      player.length !== 1 ||
      identity.entityId !== player[0]!.id ||
      !members.some(
        (x) =>
          x.id === scope.npcId &&
          x.entityType === "npc" &&
          x.canonicalName === "Sentinel-001" &&
          x.status === "active",
      )
    )
      throw new Error(
        "The pilot does not have the one approved test human and NPC.",
      );

    const audits = await tx
      .select()
      .from(contextIntakePolicyAudit)
      .where(eq(contextIntakePolicyAudit.worldId, scope.worldId));
    if (
      audits.length !== 1 ||
      audits[0]!.id !== scope.policyAuditId ||
      audits[0]!.contextId !== scope.contextId ||
      audits[0]!.previousPolicy !== "disabled" ||
      audits[0]!.targetPolicy !== "mapped_players"
    )
      throw new Error("Pilot policy audit history is unexpected.");

    const stored = await tx
      .select()
      .from(interactions)
      .where(eq(interactions.worldId, scope.worldId));
    const deliveries = await tx
      .select()
      .from(responseDeliveries)
      .where(eq(responseDeliveries.worldId, scope.worldId));
    const presence = await tx
      .select()
      .from(localPresence)
      .where(eq(localPresence.worldId, scope.worldId));
    if (deliveries.length || presence.length)
      throw new Error("Pilot contains an unexpected delivery or presence.");
    if (phase === "before") {
      if (stored.length || sourceMessageId)
        throw new Error(
          "Pilot was already used; inbound-only smoke must be one-shot.",
        );
    } else {
      const interaction = stored[0];
      if (
        !sourceMessageId ||
        stored.length !== 1 ||
        !interaction ||
        interaction.contextId !== scope.contextId ||
        interaction.npcId !== scope.npcId ||
        interaction.speakerEntityId !== player[0]!.id ||
        interaction.sourceProvider !== "discord" ||
        interaction.sourceMessageId !== sourceMessageId ||
        interaction.sourceGuildId !== config.guildId ||
        interaction.sourceChannelId !== config.parentId ||
        interaction.sourceThreadId !== config.threadId ||
        interaction.sourceMappingId !== routes[0]!.id ||
        interaction.status !== "received" ||
        (interaction.requestText !==
          "<@" + config.botId + "> [Sentinel] Report readiness." &&
          interaction.requestText !==
            "<@!" + config.botId + "> [Sentinel] Report readiness.") ||
        interaction.responseText !== null ||
        interaction.responseClaimId !== null ||
        interaction.responseMessageId !== null ||
        interaction.responsePromptVersion !== null ||
        interaction.responseGenerationOutcome !== null
      )
        throw new Error(
          "The pilot did not persist exactly one inert received interaction.",
        );
    }

    if (scope.originalWorldId) {
      const oldWorld = await tx
        .select()
        .from(worlds)
        .where(eq(worlds.id, scope.originalWorldId));
      const oldScenes = await tx
        .select()
        .from(interactionContexts)
        .where(eq(interactionContexts.worldId, scope.originalWorldId));
      const oldIdentities = await tx
        .select()
        .from(discordIdentities)
        .where(eq(discordIdentities.worldId, scope.originalWorldId));
      const oldInteractions = await tx
        .select()
        .from(interactions)
        .where(eq(interactions.worldId, scope.originalWorldId));
      const oldDeliveries = await tx
        .select()
        .from(responseDeliveries)
        .where(eq(responseDeliveries.worldId, scope.originalWorldId));
      const oldAudits = await tx
        .select()
        .from(contextIntakePolicyAudit)
        .where(eq(contextIntakePolicyAudit.worldId, scope.originalWorldId));
      if (
        oldWorld.length !== 1 ||
        oldScenes.length !== 1 ||
        oldScenes[0]!.npcIntakePolicy !== "disabled" ||
        oldIdentities.length ||
        oldInteractions.length ||
        oldDeliveries.length ||
        oldAudits.length
      )
        throw new Error("The original DEV fixture is no longer pristine.");
    }
  });
}

export async function verifyPilotInboundDatabaseIdentity(
  db: DatabaseClient["db"],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw("set transaction read only"));
    const result = await tx.execute(
      sql.raw(
        "select current_database() as database, current_user as role, " +
          "current_setting('server_version_num')::int as version, " +
          "(select rolsuper from pg_roles where rolname=current_user) as superuser",
      ),
    );
    const row = result.rows[0];
    if (
      !row ||
      row.database !== expectedDb ||
      row.role !== expectedRole ||
      typeof row.version !== "number" ||
      row.version < 170000 ||
      row.version >= 180000 ||
      row.superuser !== false
    )
      throw new Error(
        "Dedicated local pilot database identity is not approved.",
      );
  });
}

type PilotClient = Pick<
  Client,
  "on" | "off" | "login" | "destroy" | "user" | "guilds"
>;
export async function connectOnePilotMessage(
  config: PilotInboundConfig,
  intake: (message: IncomingMessage, botId: string) => Promise<string>,
  verifyAfter: (sourceMessageId: string) => Promise<void>,
  client: PilotClient = new Client({
    // The direct app mention permits content without privileged MessageContent.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  }),
  timeoutMs = 90_000,
  diagnose?: PilotInboundDiagnostic,
): Promise<void> {
  let ready = false;
  let claimed = false;
  const pending = new Set<Promise<void>>();
  let complete!: () => void;
  let fail!: (reason: Error) => void;
  const observed = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  const timeout = setTimeout(() => {
    diagnose?.(claimed ? "timeout_during_processing" : "timeout_without_match");
    fail(new Error("The one-message pilot window expired."));
  }, timeoutMs);
  const onSignal = () => {
    diagnose?.("operator_interrupted");
    fail(new Error("Pilot smoke interrupted."));
  };
  const onReady = () => {
    if (
      client.user?.id !== config.botId ||
      !client.guilds.cache.has(config.guildId)
    ) {
      fail(new Error("Unexpected bot identity or DEV guild."));
      return;
    }
    ready = true;
    console.info(JSON.stringify({ event: "pilot_gateway_ready" }));
  };
  const onMessage = (message: Message) => {
    if (!ready || claimed) return;
    const normalized = pickPilotInboundMessage(message, config, diagnose);
    if (!normalized) return;
    claimed = true; // Synchronous single-event latch before the first await.
    client.off(Events.MessageCreate, onMessage);
    const work = (async () => {
      let outcome: string;
      try {
        outcome = await intake(normalized, config.botId);
      } catch {
        diagnose?.("intake_failed");
        throw new Error("Pilot intake failed.");
      }
      if (outcome !== "accepted") {
        diagnose?.("intake_rejected");
        throw new Error("The one authorized message was not accepted.");
      }
      diagnose?.("intake_accepted");
      try {
        await verifyAfter(normalized.sourceMessageId);
      } catch {
        diagnose?.("post_write_audit_failed");
        throw new Error("One-shot post-write audit failed.");
      }
      diagnose?.("post_write_audit_pass");
      console.info(JSON.stringify({ event: "pilot_gateway_received" }));
      console.info(JSON.stringify({ event: "pilot_gateway_audit_pass" }));
      complete();
    })();
    pending.add(work);
    void work
      .catch((error: unknown) => {
        fail(
          error instanceof Error ? error : new Error("Pilot intake failed."),
        );
      })
      .finally(() => pending.delete(work));
  };
  const onError = () => {
    diagnose?.("gateway_interrupted");
    fail(new Error("Gateway transport failure."));
  };
  client.on(Events.ClientReady, onReady);
  client.on(Events.MessageCreate, onMessage);
  client.on(Events.Error, onError);
  client.on(Events.ShardError, onError);
  client.on(Events.ShardDisconnect, onError);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await Promise.all([client.login(config.token), observed]);
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    client.off(Events.ClientReady, onReady);
    client.off(Events.MessageCreate, onMessage);
    client.off(Events.Error, onError);
    client.off(Events.ShardError, onError);
    client.off(Events.ShardDisconnect, onError);
    try {
      await client.destroy();
    } finally {
      // A disconnect, SIGINT or timeout may race with an in-flight database
      // transaction. Drain the one claimed task before the caller closes pg.
      await Promise.allSettled(pending);
      console.info(JSON.stringify({ event: "pilot_gateway_stopped" }));
    }
  }
}

export async function runPilotInboundCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
): Promise<{ event: string }> {
  const mode = parsePilotInboundArguments(args);
  const config = validatePilotInboundEnvironment(env);
  const database = connect(env);
  try {
    await verifyPilotInboundDatabaseIdentity(database.db);
    await verifyPilotInboundDatabase(database.db, config, "before");
    if (mode === "preflight") return { event: "pilot_gateway_preflight_valid" };
    // No application runtime, response pipeline, outbound delivery or LLM.
    const intake = createDiscordIntake(createDiscordPersistence(database.db));
    await connectOnePilotMessage(config, intake, (sourceMessageId) =>
      verifyPilotInboundDatabase(database.db, config, "after", sourceMessageId),
    );
    return { event: "pilot_gateway_complete" };
  } finally {
    await database.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runPilotInboundCommand(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      // Never log token, user ID, message content, SQL or raw Discord errors.
      console.error(JSON.stringify({ event: "pilot_gateway_failed_safely" }));
      process.exitCode = 1;
    },
  );
}
