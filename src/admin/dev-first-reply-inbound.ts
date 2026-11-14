import { pathToFileURL } from "node:url";
import { Client } from "discord.js";
import { and, eq, sql } from "drizzle-orm";

import { createDiscordPersistence } from "../adapters/discord/persistence.js";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { contextIntakePolicyAudit } from "../db/schema/context-intake-policy-audit.js";
import { discordIdentities } from "../db/schema/discord-identities.js";
import { entities } from "../db/schema/entities.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { localPresence } from "../db/schema/local-presence.js";
import { sceneSpeechPolicies } from "../db/schema/scene-speech-policies.js";
import { worlds } from "../db/schema/worlds.js";
import { createDiscordIntake } from "../intake/discord-intake.js";
import {
  connectOnePilotMessage,
  type PilotInboundConfig,
} from "./discord-pilot-gateway.js";
import {
  isFreshNpcE2eSource,
  npcE2eGatewayIntents,
  verifyNpcE2eInboundDatabase,
  type NpcE2eInboundConfig,
} from "./discord-npc-e2e-inbound.js";
import { validateGatewaySmokeConfig } from "./discord-gateway-smoke.js";
import {
  firstReplyWorldKey,
  validateFirstReplyProvisionEnvironment,
} from "./dev-first-reply-provision.js";

// A NEW DEV-only one-message inbound. It reuses the tested authenticated
// Discord SDK receiver and PostgreSQL facts, but NEVER the consumed target.
type Database = Omit<DatabaseClient["db"], "$client">;
const dbName = "living_world_gateway_dev";
export type FirstReplyInboundMode = "preflight" | "connect" | "connect_content";

export function parseFirstReplyInboundArguments(
  args: readonly string[],
  route: { guildId: string; channelId: string; threadId: string },
): FirstReplyInboundMode {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preflight"))
    return "preflight";
  const required = [
    "--connect",
    "--confirm-world",
    firstReplyWorldKey,
    "--confirm-guild",
    route.guildId,
    "--confirm-parent",
    route.channelId,
    "--confirm-thread",
    route.threadId,
    "--confirm-database",
    dbName,
    "--inbound-only",
    "--one-message",
  ];
  if (
    args.length === required.length &&
    required.every((v, i) => args[i] === v)
  )
    return "connect";
  if (
    args.length === required.length + 1 &&
    required.every((v, i) => args[i] === v) &&
    args[required.length] === "--confirm-message-content-intent"
  )
    return "connect_content";
  throw Error(
    "First-reply live Gateway requires exact one-message confirmation.",
  );
}

export function validateFirstReplyInboundEnvironment(
  env: NodeJS.ProcessEnv,
  mode: FirstReplyInboundMode,
) {
  const smoke = validateGatewaySmokeConfig(env);
  const { route, userId } = validateFirstReplyProvisionEnvironment(
    env,
    "prepare",
  );
  if (!userId || smoke.guildId !== route.guildId)
    throw Error("Only the approved synthetic DEV human is allowed.");
  if (mode !== "preflight" && env.LW_FIRST_REPLY_GATEWAY_APPROVED !== "true")
    throw Error("A separate owner Gateway approval is required.");
  if (
    mode === "connect_content" &&
    env.LW_FIRST_REPLY_PRIVILEGED_CONTENT_APPROVED !== "true"
  )
    throw Error("Privileged message-content approval is missing.");
  return { route, userId, botId: smoke.botId, token: smoke.token };
}

// Read-only scoped lookup: avoids pinning local DB UUIDs in code or requiring
// the PO to copy identifiers from previous fixtures.
export async function loadFirstReplyInboundScope(
  db: Database,
  route: { guildId: string; channelId: string; threadId: string },
  userId: string,
  botId: string,
  token: string,
): Promise<NpcE2eInboundConfig> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw("set transaction read only"));
    await tx.execute(sql.raw("set local statement_timeout='8s'"));
    const candidate = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.key, firstReplyWorldKey))
      .limit(2);
    if (
      candidate.length !== 1 ||
      candidate[0]!.status !== "active" ||
      candidate[0]!.systemType !== "test"
    )
      throw Error("A unique new first-reply world is required.");
    const world = candidate[0]!;
    const scenes = await tx
      .select()
      .from(interactionContexts)
      .where(eq(interactionContexts.worldId, world.id));
    const scene = scenes[0];
    if (
      scenes.length !== 1 ||
      !scene ||
      scene.npcIntakePolicy !== "mapped_players" ||
      scene.externalGuildId !== route.guildId ||
      scene.externalChannelId !== route.channelId ||
      scene.externalThreadId !== route.threadId
    )
      throw Error("First-reply scene and route are not active.");
    const npc = await tx
      .select()
      .from(entities)
      .where(
        and(eq(entities.worldId, world.id), eq(entities.entityType, "npc")),
      );
    const identities = await tx
      .select()
      .from(discordIdentities)
      .where(eq(discordIdentities.worldId, world.id));
    const audits = await tx
      .select()
      .from(contextIntakePolicyAudit)
      .where(eq(contextIntakePolicyAudit.worldId, world.id));
    const presences = await tx
      .select()
      .from(localPresence)
      .where(eq(localPresence.worldId, world.id));
    const policies = await tx
      .select()
      .from(sceneSpeechPolicies)
      .where(eq(sceneSpeechPolicies.worldId, world.id));
    const now = Date.now();
    if (
      npc.length !== 1 ||
      npc[0]!.canonicalName !== "Sentinel-001" ||
      identities.length !== 1 ||
      identities[0]!.discordUserId !== userId ||
      identities[0]!.status !== "active" ||
      audits.length !== 1 ||
      audits[0]!.targetPolicy !== "mapped_players" ||
      presences.length !== 1 ||
      presences[0]!.revokedAt !== null ||
      policies.length !== 1 ||
      policies[0]!.revokedAt !== null ||
      policies[0]!.decision !== "allow_direct_speech" ||
      policies[0]!.expiresAt.getTime() <= now ||
      policies[0]!.issuedAt.getTime() > now ||
      policies[0]!.npcId !== npc[0]!.id ||
      policies[0]!.contextId !== scene.id ||
      policies[0]!.presenceId !== presences[0]!.id
    )
      throw Error(
        "First-reply player, presence, audit or host policy is unsafe.",
      );

    const scope: PilotInboundConfig["scope"] = {
      worldKey: firstReplyWorldKey,
      worldId: world.id,
      contextId: scene.id,
      npcId: npc[0]!.id,
      playerMappingId: identities[0]!.id,
      policyAuditId: audits[0]!.id,
    };
    return {
      botId,
      token,
      guildId: route.guildId,
      parentId: route.channelId,
      threadId: route.threadId,
      playerId: userId,
      scope,
      presenceId: presences[0]!.id,
    };
  });
}

export async function runFirstReplyInboundCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
): Promise<{
  event: "npc_first_reply_inbound";
  status: "ready" | "received";
  canSend: false;
}> {
  const { route, userId, botId, token } = validateFirstReplyInboundEnvironment(
    env,
    "preflight",
  );
  const mode = parseFirstReplyInboundArguments(args, route);
  validateFirstReplyInboundEnvironment(env, mode);
  const client = connect(env);
  try {
    const config = await loadFirstReplyInboundScope(
      client.db,
      route,
      userId,
      botId,
      token,
    );
    await verifyNpcE2eInboundDatabase(client.db, config, "before");
    if (mode === "preflight")
      return {
        event: "npc_first_reply_inbound",
        status: "ready",
        canSend: false,
      };

    const armedAt = Date.now();
    const intake = createDiscordIntake(createDiscordPersistence(client.db));
    const gateway =
      mode === "connect_content"
        ? new Client({ intents: npcE2eGatewayIntents(true) })
        : undefined;
    await connectOnePilotMessage(
      config,
      async (message, targetBot) => {
        if (!isFreshNpcE2eSource(message.sourceMessageId, armedAt, Date.now()))
          return "stale";
        return intake(message, targetBot);
      },
      (sourceMessageId) =>
        verifyNpcE2eInboundDatabase(
          client.db,
          config,
          "after",
          sourceMessageId,
        ),
      gateway,
      90_000,
      (stage) =>
        console.info(
          JSON.stringify({
            event: "npc_first_reply_inbound_diagnostic",
            stage,
          }),
        ),
    );
    return {
      event: "npc_first_reply_inbound",
      status: "received",
      canSend: false,
    };
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runFirstReplyInboundCommand(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      // Fixed category only: never leak token, IDs or player content.
      console.error(
        JSON.stringify({ event: "npc_first_reply_inbound_failed_safely" }),
      );
      process.exitCode = 1;
    },
  );
}
