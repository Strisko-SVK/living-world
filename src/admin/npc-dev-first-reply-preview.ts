import { pathToFileURL } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { worlds } from "../db/schema/worlds.js";
import { entities } from "../db/schema/entities.js";
import { entityAliases } from "../db/schema/entity-aliases.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { interactions } from "../db/schema/interactions.js";
import { discordContextMappings } from "../db/schema/discord-context-mappings.js";
import { discordIdentities } from "../db/schema/discord-identities.js";
import { localPresence } from "../db/schema/local-presence.js";
import { sceneSpeechPolicies } from "../db/schema/scene-speech-policies.js";
import { responseDeliveries } from "../db/schema/response-deliveries.js";
import { discordMessageCreatedAt } from "../intake/discord-snowflake.js";
import { parseDiscordTrigger } from "../intake/discord-trigger.js";
import { assessSceneContact } from "../communication/scene-contact.js";
import { readNpcSummonFacts } from "../communication/summon-facts.repository.js";
import {
  assessOfflineSpeechReadiness,
  type TrustedSceneSpeechApproval,
} from "../communication/scene-speech-readiness.js";
import { validateGatewayDevDatabaseEnv } from "./gateway-dev-db.js";
import { gatewaySmokeBotId } from "./discord-gateway-smoke.js";

// This is a REAL local-DEV database preview, not a synthetic in-memory gate.
// It must never write, authorize a send, connect to Discord or call an LLM.
// A separately reviewed live pilot must revalidate state at its action boundary.
type Database = Omit<DatabaseClient["db"], "$client">;
const snowflake = z.string().regex(/^[1-9][0-9]{16,19}$/u);
const configSchema = z
  .object({
    worldKey: z
      .string()
      .regex(
        /^(?:lw-dev-first-reply-[a-z0-9-]{1,24}|npc-gateway-ci-[a-f0-9-]{36})$/u,
      ),
    guildId: snowflake,
    channelId: snowflake,
    threadId: snowflake,
    playerId: snowflake,
  })
  .strict();
export type DevFirstReplyConfig = z.infer<typeof configSchema>;
export type DevFirstReplyReason =
  | "unsafe_environment"
  | "database_identity_denied"
  | "fixture_missing"
  | "scene_denied"
  | "source_missing"
  | "source_denied"
  | "policy_denied"
  | "outbox_exists"
  | "integrity_denied"
  | "read_failed"
  | "validated_fake_only";
export type DevFirstReplyPreview = {
  event: "npc_dev_first_reply_preview";
  status: "blocked" | "fake_only_candidate";
  reason: DevFirstReplyReason;
  readOnly: true;
  canGenerate: false;
  canSend: false;
  wouldSend: false;
};
function report(reason: DevFirstReplyReason): DevFirstReplyPreview {
  return {
    event: "npc_dev_first_reply_preview",
    status: reason === "validated_fake_only" ? "fake_only_candidate" : "blocked",
    reason,
    readOnly: true,
    canGenerate: false,
    canSend: false,
    wouldSend: false,
  };
}
export function parseDevFirstReplyArguments(args: readonly string[]): void {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return;
  throw Error("This DEV command is read-only.");
}

export function validateDevFirstReplyEnvironment(
  env: NodeJS.ProcessEnv,
): DevFirstReplyConfig {
  validateGatewayDevDatabaseEnv(env);
  const config = configSchema.parse({
    worldKey: env.LW_FIRST_REPLY_WORLD_KEY,
    guildId: env.LW_FIRST_REPLY_GUILD_ID,
    channelId: env.LW_FIRST_REPLY_PARENT_ID,
    threadId: env.LW_FIRST_REPLY_THREAD_ID,
    playerId: env.LW_FIRST_REPLY_PLAYER_ID,
  });
  if (
    !config.worldKey.startsWith("lw-dev-first-reply-") ||
    config.guildId !== env.LW_DEV_GUILD_ID ||
    config.playerId === gatewaySmokeBotId ||
    new Set([
      config.guildId,
      config.channelId,
      config.threadId,
      config.playerId,
    ]).size !== 4 ||
    [
      env.LW_DEV_PARENT_CHANNEL_ID,
      env.LW_DEV_THREAD_ID,
      env.LW_PILOT_PARENT_CHANNEL_ID,
      env.LW_PILOT_THREAD_ID,
      env.LW_NPC_E2E_PARENT_CHANNEL_ID,
      env.LW_NPC_E2E_THREAD_ID,
    ].includes(config.channelId) ||
    [
      env.LW_DEV_PARENT_CHANNEL_ID,
      env.LW_DEV_THREAD_ID,
      env.LW_PILOT_PARENT_CHANNEL_ID,
      env.LW_PILOT_THREAD_ID,
      env.LW_NPC_E2E_PARENT_CHANNEL_ID,
      env.LW_NPC_E2E_THREAD_ID,
    ].includes(config.threadId)
  )
    throw Error("A new, isolated first-reply DEV scene is required.");
  return config;
}

// Reuses authoritative database facts, but is intentionally only an advisory
// reader. No SELECT FOR UPDATE/SHARE, no transaction mutation, no dispatch.
// The caller is responsible for setting the transaction to READ ONLY first.
export async function inspectDevFirstReplyFacts(
  db: Database,
  input: unknown,
): Promise<DevFirstReplyPreview> {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) return report("unsafe_environment");
  const config = parsed.data;
  if (
    !config.worldKey.startsWith("lw-dev-first-reply-") &&
    !(
      process.env.NODE_ENV === "test" &&
      config.worldKey.startsWith("npc-gateway-ci-")
    )
  )
    return report("unsafe_environment");
  try {
    const clock = await db.execute(
      sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as now_ms`,
    );
    const nowMs = Number(clock.rows[0]?.now_ms);
    if (!Number.isSafeInteger(nowMs)) return report("read_failed");

    const guard = await db.execute(sql`
      select tgname from pg_trigger where not tgisinternal
      and tgenabled = 'O' and tgname in (
        'discord_route_revision',
        'scene_speech_policy_immutable',
        'scene_speech_policy_no_truncate'
      )
    `);
    const triggers = new Set(guard.rows.map((x) => x.tgname));
    if (
      !triggers.has("discord_route_revision") ||
      !triggers.has("scene_speech_policy_immutable") ||
      !triggers.has("scene_speech_policy_no_truncate")
    )
      return report("integrity_denied");

    const candidateWorlds = await db
      .select()
      .from(worlds)
      .where(eq(worlds.key, config.worldKey))
      .limit(2);
    if (candidateWorlds.length === 0) return report("fixture_missing");
    const world = candidateWorlds[0]!;
    if (
      candidateWorlds.length !== 1 ||
      world.status !== "active" ||
      world.systemType !== "test"
    )
      return report("scene_denied");

    const scope = { worldId: world.id };
    const [scenes, routes, records, outbox] = await Promise.all([
      db
        .select()
        .from(interactionContexts)
        .where(eq(interactionContexts.worldId, scope.worldId))
        .limit(2),
      db
        .select()
        .from(discordContextMappings)
        .where(
          and(
            eq(discordContextMappings.guildId, config.guildId),
            eq(discordContextMappings.channelId, config.channelId),
          ),
        )
        .limit(2),
      db
        .select()
        .from(interactions)
        .where(eq(interactions.worldId, scope.worldId))
        .limit(2),
      db
        .select({ id: responseDeliveries.id })
        .from(responseDeliveries)
        .where(eq(responseDeliveries.worldId, scope.worldId))
        .limit(1),
    ]);
    if (outbox.length) return report("outbox_exists");
    if (scenes.length !== 1 || routes.length !== 1)
      return report("scene_denied");
    const scene = scenes[0]!;
    const route = routes[0]!;
    if (
      scene.status !== "active" ||
      scene.contextType !== "scene" ||
      scene.npcIntakePolicy !== "mapped_players" ||
      scene.externalProvider !== "discord" ||
      scene.externalGuildId !== config.guildId ||
      scene.externalChannelId !== config.channelId ||
      scene.externalThreadId !== config.threadId ||
      !scene.linkedLocationEntityId ||
      route.id === "" ||
      route.worldId !== world.id ||
      route.contextId !== scene.id ||
      route.status !== "active" ||
      route.mappingType !== "scene" ||
      route.npcId !== null ||
      route.threadId !== config.threadId
    )
      return report("scene_denied");

    if (records.length === 0) return report("source_missing");
    if (records.length !== 1) return report("source_denied");
    const source = records[0]!;
    const sourceEventMs = discordMessageCreatedAt(source.sourceMessageId);
    if (
      !sourceEventMs ||
      sourceEventMs > nowMs ||
      nowMs - sourceEventMs > 120_000 ||
      source.sourceProvider !== "discord" ||
      source.status !== "received" ||
      source.communicationMode !== "unknown" ||
      source.localPresenceId !== null ||
      source.responseClaimId !== null ||
      source.responseText !== null ||
      source.responseMessageId !== null ||
      source.sourceGuildId !== config.guildId ||
      source.sourceChannelId !== config.channelId ||
      source.sourceThreadId !== config.threadId ||
      source.sourceMappingId !== route.id ||
      source.contextId !== scene.id ||
      !source.npcId ||
      !source.speakerEntityId ||
      route.updatedAt.getTime() > sourceEventMs ||
      source.createdAt.getTime() < sourceEventMs ||
      source.createdAt.getTime() > nowMs
    )
      return report("source_denied");

    const trigger = parseDiscordTrigger(source.requestText, gatewaySmokeBotId, [
      gatewaySmokeBotId,
    ]);
    if (!trigger) return report("source_denied");
    const [players, aliases, presences] = await Promise.all([
      db
        .select()
        .from(discordIdentities)
        .where(eq(discordIdentities.worldId, world.id))
        .limit(2),
      db
        .select({ npcId: entityAliases.entityId })
        .from(entityAliases)
        .innerJoin(entities, eq(entityAliases.entityId, entities.id))
        .where(
          and(
            eq(entities.worldId, world.id),
            eq(entities.status, "active"),
            eq(entityAliases.normalizedAlias, trigger.alias),
          ),
        )
        .limit(2),
      db
        .select()
        .from(localPresence)
        .where(
          and(
            eq(localPresence.worldId, world.id),
            eq(localPresence.npcId, source.npcId),
            eq(localPresence.contextId, scene.id),
          ),
        )
        .limit(2),
    ]);
    if (
      players.length !== 1 ||
      players[0]!.discordUserId !== config.playerId ||
      players[0]!.entityId !== source.speakerEntityId ||
      players[0]!.status !== "active" ||
      players[0]!.mappingType !== "player_character" ||
      aliases.length !== 1 ||
      aliases[0]!.npcId !== source.npcId ||
      presences.length !== 1 ||
      presences[0]!.revokedAt !== null
    )
      return report("source_denied");

    const player = await db
      .select({ type: entities.entityType, status: entities.status })
      .from(entities)
      .where(
        and(
          eq(entities.id, source.speakerEntityId),
          eq(entities.worldId, world.id),
        ),
      )
      .limit(1);
    if (
      player[0]?.type !== "player_character" ||
      player[0]?.status !== "active"
    )
      return report("source_denied");

    const presence = presences[0]!;
    const policies = await db
      .select()
      .from(sceneSpeechPolicies)
      .where(
        and(
          eq(sceneSpeechPolicies.worldId, world.id),
          eq(sceneSpeechPolicies.npcId, source.npcId),
          eq(sceneSpeechPolicies.contextId, scene.id),
          eq(sceneSpeechPolicies.presenceId, presence.id),
        ),
      )
      .limit(2);
    if (policies.length !== 1) return report("policy_denied");
    const policy = policies[0]!;
    if (
      policy.issuerRole !== "host_operator" ||
      (policy.issuedBy !== "lw_gateway_dev" &&
        !(
          process.env.NODE_ENV === "test" &&
          policy.issuedBy === "living_world_ci"
        )) ||
      policy.revokedAt !== null ||
      policy.expiresAt.getTime() <= nowMs ||
      policy.issuedAt.getTime() > sourceEventMs ||
      policy.npcStateVersion !== presence.stateVersion
    )
      return report("policy_denied");

    const issuer = await db
      .select({ status: entities.status })
      .from(entities)
      .where(
        and(
          eq(entities.worldId, world.id),
          eq(entities.id, policy.issuerEntityId),
        ),
      )
      .limit(1);
    if (issuer[0]?.status !== "active") return report("policy_denied");

    const facts = await readNpcSummonFacts(db, {
      worldId: world.id,
      npcId: source.npcId,
      contextId: scene.id,
    });
    if (!facts) return report("policy_denied");
    const contact = assessSceneContact({
      worldId: world.id,
      npcId: source.npcId,
      contextId: scene.id,
      facts,
      presence: {
        id: presence.id,
        worldId: presence.worldId,
        npcId: presence.npcId,
        contextId: presence.contextId,
        locationId: presence.locationId,
        stateVersion: presence.stateVersion,
        issuedAt: presence.issuedAt,
        revokedAt: presence.revokedAt,
      },
      sourceEventMs,
    });

    const approval: TrustedSceneSpeechApproval = {
      id: policy.id,
      worldId: world.id,
      npcId: source.npcId,
      contextId: scene.id,
      presenceId: presence.id,
      npcStateVersion: policy.npcStateVersion,
      issuedByEntityId: policy.issuerEntityId,
      issuedByRole: "host_operator",
      decision: policy.decision as TrustedSceneSpeechApproval["decision"],
      activity: policy.activity as TrustedSceneSpeechApproval["activity"],
      perception: policy.perception as TrustedSceneSpeechApproval["perception"],
      otherScene: policy.otherScene as TrustedSceneSpeechApproval["otherScene"],
      issuedAt: policy.issuedAt,
      expiresAt: policy.expiresAt,
      revokedAt: policy.revokedAt,
    };
    const verdict = assessOfflineSpeechReadiness({
      worldId: world.id,
      npcId: source.npcId,
      contextId: scene.id,
      interactionId: source.id,
      presenceId: presence.id,
      npcStateVersion: facts.stateVersion,
      sourceMessageId: source.sourceMessageId,
      nowMs,
      contact,
      approval,
    });
    return verdict.canRehearseFake
      ? report("validated_fake_only")
      : report("policy_denied");
  } catch {
    // Sanitized verdict only, never return raw IDs, private player text or SQL.
    return report("read_failed");
  }
}

export async function runDevFirstReplyPreview(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
): Promise<DevFirstReplyPreview> {
  let config: DevFirstReplyConfig;
  try {
    parseDevFirstReplyArguments(args);
    config = validateDevFirstReplyEnvironment(env);
  } catch {
    return report("unsafe_environment");
  }

  let client: ReturnType<typeof createDatabaseClient> | undefined;
  try {
    client = connect(env);
    return await client.db.transaction(async (tx) => {
      // First SQL statement of the transaction: PostgreSQL enforces no writes.
      await tx.execute(sql.raw("set transaction read only"));
      await tx.execute(sql.raw("set local statement_timeout = '8s'"));
      const result = await tx.execute(sql`
        select current_database() as database, current_user as db_role,
          current_setting('server_version_num')::int as version,
          (select rolsuper from pg_roles where rolname=current_user) as superuser,
          (select rolcreatedb from pg_roles where rolname=current_user) as createdb,
          (select rolcreaterole from pg_roles where rolname=current_user) as createrole
      `);
      const role = result.rows[0];
      if (
        role?.database !== "living_world_gateway_dev" ||
        role.db_role !== "lw_gateway_dev" ||
        typeof role.version !== "number" ||
        role.version < 170000 ||
        role.version >= 180000 ||
        role.superuser !== false ||
        role.createdb !== false ||
        role.createrole !== false
      )
        return report("database_identity_denied");
      return inspectDevFirstReplyFacts(tx, config);
    });
  } catch {
    return report("read_failed");
  } finally {
    if (client) await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runDevFirstReplyPreview(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      console.error(JSON.stringify(report("read_failed")));
      process.exitCode = 1;
    },
  );
}
