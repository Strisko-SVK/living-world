import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { createDiscordPersistence } from "../adapters/discord/persistence.js";
import {
  createDiscordIntake,
  type IncomingMessage,
} from "../intake/discord-intake.js";
import { parseDiscordTrigger } from "../intake/discord-trigger.js";
import { discordMessageCreatedAt } from "../intake/discord-snowflake.js";
import { prepareLocalInteraction } from "../communication/local.repository.js";
import { createNpcResponsePipeline } from "../response/composition.js";
import { createDeliveryRepository } from "../delivery/delivery.repository.js";
import { createDeliveryDispatcher } from "../delivery/dispatch.js";
import { fingerprint, type DeliveryTransport } from "../delivery/contracts.js";
import { postScopedBotReply } from "./dev-first-reply-transport.js";
import { type RaonFixture } from "./raon-dev-fixture.js";
import type { DevFixtureRoute } from "./discord-dev-fixture.js";

export const raonSourceAgeMs = 120_000;
const playerText = (text: string) =>
  text.replace(/<(?:@!?[0-9]+|@&[0-9]+|#[0-9]+)>/gu, "[Discord mention]");

type TurnConfig = {
  fixture: RaonFixture;
  route: DevFixtureRoute;
  playerId: string;
  botId: string;
  policyId: string | (() => string);
  token: string;
  personaWebhook?: { id: string; url: string };
  startedAt: number;
  signal: AbortSignal;
  verifyPermissions: () => Promise<boolean>;
  diagnose: (event: {
    event: string;
    outcome?: string;
    latencyMs?: number;
    traceId?: string;
  }) => void;
  http?: typeof fetch;
  inferenceHttp?: typeof fetch;
};

export function createRaonDevTurn(
  db: Omit<DatabaseClient["db"], "$client">,
  env: NodeJS.ProcessEnv,
  config: TurnConfig,
) {
  const {
    fixture: f,
    route,
    playerId,
    botId,
    signal,
    diagnose,
  } = config;
  const intake = createDiscordIntake(createDiscordPersistence(db, f), diagnose);
  const pipeline = createNpcResponsePipeline(
    db,
    env,
    diagnose,
    (value) => {
      diagnose({ ...value, event: "raon_generation", outcome: value.outcome });
    },
    config.inferenceHttp,
  );
  const repository = createDeliveryRepository(db);
  const history: { player: string; speech: string }[] = [];

  return async (message: IncomingMessage, authenticatedBotId: string) => {
    const received = performance.now();
    const policyId =
      typeof config.policyId === "function"
        ? config.policyId()
        : config.policyId;
    const sourceMs = discordMessageCreatedAt(message.sourceMessageId);
    const trigger = parseDiscordTrigger(
      message.content,
      authenticatedBotId,
      message.mentionedUserIds,
    );
    if (
      signal.aborted ||
      authenticatedBotId !== botId ||
      message.authorId !== playerId ||
      message.guildId !== route.guildId ||
      message.channelId !== route.channelId ||
      message.threadId !== route.threadId ||
      (trigger?.alias !== "sentinel" && trigger?.alias !== "sentinel-001") ||
      sourceMs === null ||
      sourceMs < config.startedAt ||
      sourceMs > Date.now() ||
      Date.now() - sourceMs > raonSourceAgeMs
    )
      return "ignored";
    const outcome = await intake(message, botId);
    if (outcome !== "accepted") return outcome;
    // Source time is computed from the authenticated SDK snowflake. All joins
    // revalidate current identity, exact route, host policy and pre-event state
    // before prompt generation, persistence, and the transport's last boundary.
    const bound = async () => {
      if (signal.aborted) return null;
      const result = await db.execute(sql`
        select i.id, i.trace_id
        from interactions i
        join worlds w on w.id=i.world_id
        join interaction_contexts c on c.id=i.context_id and c.world_id=i.world_id
        join discord_context_mappings m on m.id=i.source_mapping_id and m.world_id=i.world_id and m.context_id=c.id
        join entities actor on actor.id=i.speaker_entity_id and actor.world_id=i.world_id
        join discord_identities d on d.world_id=i.world_id and d.entity_id=actor.id
        join npc_scene_speech_policies p on p.world_id=i.world_id and p.npc_id=i.npc_id and p.context_id=i.context_id
        join local_presence lp on lp.id=p.presence_id
        join npc_state ns on ns.npc_id=i.npc_id
        where w.id=${f.worldId} and w.key=${f.worldKey} and w.status='active' and w.system_type='test'
          and c.id=${f.contextId} and c.status='active' and c.context_type='scene'
          and c.npc_intake_policy='mapped_players' and c.external_provider='discord'
          and c.external_guild_id=${route.guildId} and c.external_channel_id=${route.channelId} and c.external_thread_id=${route.threadId}
          and i.npc_id=${f.npcId} and i.source_provider='discord' and i.source_message_id=${message.sourceMessageId}
          and i.source_guild_id=${route.guildId} and i.source_channel_id=${route.channelId} and i.source_thread_id=${route.threadId}
          and i.request_text=${message.content}
          and m.id=${f.mappingId} and m.guild_id=i.source_guild_id and m.channel_id=i.source_channel_id
          and m.thread_id=i.source_thread_id and m.status='active' and m.mapping_type='scene' and m.npc_id is null
          and m.updated_at <= to_timestamp(${sourceMs}::double precision / 1000)
          and not exists (select 1 from discord_context_mappings other where other.id<>m.id
            and other.guild_id=m.guild_id and other.channel_id=m.channel_id and other.status='active')
          and actor.id=${f.playerEntityId} and actor.status='active' and actor.entity_type='player_character'
          and d.discord_user_id=${playerId} and d.mapping_type='player_character' and d.status='active'
          and p.id=${policyId} and p.issuer_entity_id=actor.id and p.issuer_role='host_operator' and p.issued_by=current_user
          and p.decision='allow_direct_speech' and p.activity='free' and p.perception='aware' and p.other_scene='none'
          and p.revoked_at is null and p.expires_at > clock_timestamp()
          and p.issued_at <= to_timestamp(${sourceMs}::double precision / 1000)
          and p.presence_id=${f.presenceId} and lp.revoked_at is null and lp.state_version=ns.version
          and ns.version=p.npc_state_version and ns.location_certainty='certain' and ns.current_location_id=c.linked_location_entity_id
          and to_timestamp(${sourceMs}::double precision / 1000) between
            clock_timestamp() - ${raonSourceAgeMs}::integer * interval '1 millisecond' and clock_timestamp()
        limit 2
      `);
      const [row] = result.rows;
      return result.rows.length === 1 &&
        typeof row.id === "string" &&
        typeof row.trace_id === "string"
        ? { id: row.id, traceId: row.trace_id }
        : null;
    };

    const row = await bound();
    if (!row) {
      diagnose({ event: "raon_binding", outcome: "blocked" });
      return "source_blocked";
    }
    const report = (event: string, outcome: string) =>
      diagnose({ event, outcome, traceId: row.traceId });
    const scope = { worldId: f.worldId, npcId: f.npcId, interactionId: row.id };
    const prepared = await prepareLocalInteraction(db, {
      ...scope,
      contextId: f.contextId,
      evidenceId: f.presenceId,
    });
    report("raon_presence", prepared.status);
    if (prepared.status !== "prepared") return "presence_blocked";
    const player = playerText(trigger.body);
    const authorize = async () =>
      (await bound())?.id === scope.interactionId && !signal.aborted;
    const source = {
      guildId: route.guildId,
      parentId: route.channelId,
      threadId: route.threadId,
      sourceMessageId: message.sourceMessageId,
      playerId,
      botId,
    };
    const permissions = config.verifyPermissions;
    const dependencies = {
      token: config.token,
      http: config.http ?? fetch,
      revalidateAtBoundary: authorize,
    };
    const persona = config.personaWebhook
      ? { webhook: config.personaWebhook, name: "Sentinel-001" }
      : undefined;
    const precheck = (checkSignal: AbortSignal = signal) =>
      postScopedBotReply(
        { ...source, attemptId: row.id },
        { ...dependencies, dryRun: true },
        {
          content: "Preflight",
          sourceContent: message.content,
          verifyPermissions: permissions,
          signal: checkSignal,
          persona,
        },
      );
    if ((await precheck()).status !== "prechecked")
      return "discord_acl_blocked";

    report("raon_npc_resolution", "sentinel");
    const typing = new AbortController();
    const typingSignal = AbortSignal.any([signal, typing.signal]);
    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    let typingWork: Promise<void> | undefined;
    const pulse = async (refresh: boolean) => {
      try {
        if (
          typingSignal.aborted ||
          (refresh && (await precheck(typingSignal)).status !== "prechecked") ||
          !(await authorize()) ||
          typingSignal.aborted
        )
          return;
        const response = await dependencies.http(
          "https://discord.com/api/v10/channels/" + route.threadId + "/typing",
          {
            method: "POST",
            redirect: "manual",
            signal: AbortSignal.any([typingSignal, AbortSignal.timeout(3000)]),
            headers: { Authorization: "Bot " + config.token },
          },
        );
        if (response.status !== 204 || response.redirected) {
          report("raon_typing", "unavailable");
          return;
        }
        if (!typingSignal.aborted) {
          if (!refresh) report("raon_typing", "started");
          typingTimer = setTimeout(() => {
            typingWork = pulse(true);
          }, 7000);
        }
      } catch {
        if (!typingSignal.aborted) report("raon_typing", "unavailable");
      }
    };
    typingWork = pulse(false);
    try {
      await typingWork;
      const response = await pipeline.generateNpcResponse(
        f.worldId,
        f.npcId,
        row.id,
        {
          signal,
          beforeAttempt: authorize,
          maxResponseChars: 600,
          dialogue: { request: player, history: [...history] },
        },
      );
      if (!response.ok) return response.providerError ?? response.error;
      if (response.status !== "responded" || !(await authorize()))
        return "delivery_blocked";
      const ready = await repository.prepare(scope);
      if (ready.status === "blocked") return ready.reason;
      const transport: DeliveryTransport = {
        async send({ payload, attemptId, fingerprint: hash }) {
          if (
            payload.scope.interactionId !== row.id ||
            payload.scope.worldId !== f.worldId ||
            payload.scope.npcId !== f.npcId ||
            payload.destination.guildId !== route.guildId ||
            payload.destination.channelId !== route.channelId ||
            payload.destination.threadId !== route.threadId ||
            payload.replyToMessageId !== message.sourceMessageId ||
            hash !== fingerprint(payload)
          )
            return { kind: "not_sent", retryable: false, retryAfterMs: 0 };
          const result = await postScopedBotReply(
            { ...source, attemptId },
            dependencies,
            {
              content: payload.content,
              sourceContent: message.content,
              verifyPermissions: permissions,
              signal,
              persona,
            },
          );
          if (result.status === "acknowledged" && result.messageId)
            return {
              kind: "acknowledged",
              ack: {
                attemptId,
                fingerprint: hash,
                destination: payload.destination,
                messageId: result.messageId,
              },
            };
          return result.attempts === 0
            ? { kind: "not_sent", retryable: false, retryAfterMs: 0 }
            : { kind: "uncertain" };
        },
      };
      const delivery = await createDeliveryDispatcher(
        repository,
        transport,
      )(scope);
      diagnose({
        event: "raon_delivery",
        outcome: delivery.status,
        latencyMs: Math.round(performance.now() - received),
        traceId: row.traceId,
      });
      if (delivery.status === "delivered" && response.interaction.responseText) {
        history.push({
          player: player.slice(0, 480),
          speech: response.interaction.responseText,
        });
        if (history.length > 3) history.shift();
      }
      return delivery.status;
    } finally {
      typing.abort();
      if (typingTimer) clearTimeout(typingTimer);
      await typingWork;
    }
  };
}
