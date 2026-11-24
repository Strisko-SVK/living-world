import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { createDiscordPersistence } from "../adapters/discord/persistence.js";
import {
  createDiscordIntake,
  incomingMessageSchema,
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
import { type RaonFixture, type RaonScene } from "./raon-dev-fixture.js";
import type { SceneRoute } from "../discord-npc/registry.js";

import { createRaonConversation, playerText } from "./raon-conversation.js";
import { getNpc } from "../domains/npc/npc.repository.js";
import { baselineProfileSchema } from "../domains/npc/npc.validation.js";

export const raonSourceAgeMs = 120_000;
export type SelectedConversation = {
  request: string;
  alias?: string;
  mentioned: boolean;
  via: "name" | "reply" | "follow_up" | "default";
  memory: ReturnType<typeof createRaonConversation>;
};

type TurnConfig = {
  fixture: RaonFixture;
  route: SceneRoute;
  native?: { authorizeRoute: () => Promise<boolean> };
  playerId: string;
  botId: string;
  policyId: string | (() => string);
  token: string;
  personaWebhook?: { id: string; url: string };
  resolveWebhook?: (
    authorize: () => Promise<boolean>,
  ) => Promise<{ id: string; url: string } | null>;
  hostEntityId?: string;
  startedAt: number;
  signal: AbortSignal;
  verifyPermissions: () => Promise<boolean>;
  diagnose: (event: {
    event: string;
    outcome?: string;
    latencyMs?: number;
    traceId?: string;
    npc?: string;
    recent?: number;
    excerpts?: number;
  }) => void;
  http?: typeof fetch;
  inferenceHttp?: typeof fetch;
};

export function createRaonDevTurn(
  db: Omit<DatabaseClient["db"], "$client">,
  env: NodeJS.ProcessEnv,
  config: TurnConfig,
) {
  const { fixture: f, route, playerId, botId, signal, diagnose } = config;
  const persistence = createDiscordPersistence(db, {
    ...f,
    ...(config.native && { native: true }),
  });
  const intake = createDiscordIntake(persistence, diagnose);
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

  return async (
    message: IncomingMessage,
    authenticatedBotId: string,
    conversation?: SelectedConversation,
  ) => {
    const received = performance.now();
    const policyId =
      typeof config.policyId === "function"
        ? config.policyId()
        : config.policyId;
    if (!policyId) return "npc_unavailable";
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
      (!conversation &&
        trigger?.alias !== "sentinel" &&
        trigger?.alias !== "sentinel-001") ||
      sourceMs === null ||
      sourceMs < config.startedAt ||
      sourceMs > Date.now() ||
      Date.now() - sourceMs > raonSourceAgeMs
    )
      return "ignored";
    const outcome = conversation
      ? await persistence.persist({
          message,
          traceId: randomUUID(),
          trigger: {
            botId,
            conversation: { npcId: f.npcId, alias: conversation.alias },
          },
        })
      : await intake(message, botId);
    if (outcome !== "accepted") return outcome;
    // Source time is computed from the authenticated SDK snowflake. All joins
    // revalidate current identity, exact route, host policy and pre-event state
    // before prompt generation, persistence, and the transport's last boundary.
    const bound = async () => {
      if (
        signal.aborted ||
        (config.native && !(await config.native.authorizeRoute()))
      )
        return null;
      const result = await db.execute(sql`
        select i.id, i.trace_id
        from interactions i
        join worlds w on w.id=i.world_id
        join interaction_contexts c on c.id=i.context_id and c.world_id=i.world_id
        join discord_context_mappings m on m.id=i.source_mapping_id and m.world_id=i.world_id and m.context_id=c.id
        join entities actor on actor.id=i.speaker_entity_id and actor.world_id=i.world_id
        join discord_identities d on d.world_id=i.world_id and d.entity_id=actor.id
        join npc_scene_speech_policies p on p.world_id=i.world_id and p.npc_id=i.npc_id and p.context_id=i.context_id
        join entities issuer on issuer.id=p.issuer_entity_id and issuer.world_id=i.world_id and issuer.status='active'
        join local_presence lp on lp.id=p.presence_id
        join npc_state ns on ns.npc_id=i.npc_id
        where w.id=${f.worldId} and w.key=${f.worldKey} and w.status='active' and w.system_type='test'
          and c.id=${f.contextId} and c.status='active' and c.context_type='scene'
          and c.npc_intake_policy='mapped_players' and c.external_provider='discord'
          and c.external_guild_id=${route.guildId} and c.external_channel_id=${route.channelId} and c.external_thread_id is not distinct from ${route.threadId}::text
          and i.npc_id=${f.npcId} and i.source_provider='discord' and i.source_message_id=${message.sourceMessageId}
          and i.source_guild_id=${route.guildId} and i.source_channel_id=${route.channelId} and i.source_thread_id is not distinct from ${route.threadId}::text
          and i.request_text=${message.content}
          and m.id=${f.mappingId} and m.guild_id=i.source_guild_id and m.channel_id=i.source_channel_id
          and m.thread_id is not distinct from i.source_thread_id and m.status='active' and m.mapping_type='scene' and m.npc_id is null
          and (not ${Boolean(config.native)} or m.updated_at <= i.created_at)
          and (${Boolean(config.native)} or m.updated_at <= to_timestamp(${sourceMs}::double precision / 1000))
          and not exists (select 1 from discord_context_mappings other where other.id<>m.id
            and other.guild_id=m.guild_id and other.channel_id=m.channel_id and other.status='active'
            and (${!conversation} or other.thread_id is null or other.thread_id=m.thread_id)
            and (not ${Boolean(config.native)} or other.world_id<>m.world_id or other.thread_id is not distinct from m.thread_id))
          and actor.id=${f.playerEntityId} and actor.status='active' and actor.entity_type='player_character'
          and d.discord_user_id=${playerId} and d.mapping_type='player_character' and d.status='active'
          and p.id=${policyId} and p.issuer_entity_id=${config.hostEntityId ?? f.playerEntityId} and p.issuer_role='host_operator' and p.issued_by=current_user
          and p.decision='allow_direct_speech' and p.activity='free' and p.perception='aware' and p.other_scene='none'
          and p.revoked_at is null and p.expires_at > clock_timestamp()
          and (not ${Boolean(config.native)} or p.issued_at <= i.created_at)
          and (case when ${Boolean(config.native)} then
              i.discord_native_source and p.discord_native_managed and ns.updated_at <= to_timestamp(${sourceMs}::double precision / 1000)
                and coalesce(ns.availability_state->>'status','available')='available'
            else p.issued_at <= to_timestamp(${sourceMs}::double precision / 1000) end)
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
    const player = playerText(conversation?.request ?? trigger!.body);
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
    const sourceBinding = conversation
      ? {
          mentioned: conversation.mentioned,
          replyToMessageId:
            conversation.via === "reply" ? message.replyToMessageId : undefined,
        }
      : undefined;
    let persona = config.personaWebhook
      ? {
          webhook: config.personaWebhook,
          name: "Sentinel-001",
          avatarUrl: undefined as string | undefined,
        }
      : undefined;
    const precheck = (checkSignal: AbortSignal = signal) =>
      postScopedBotReply(
        { ...source, attemptId: row.id },
        { ...dependencies, dryRun: true },
        {
          content: "Preflight",
          sourceContent: message.content,
          conversationSource: sourceBinding,
          verifyPermissions: permissions,
          signal: checkSignal,
          persona,
        },
      );
    // Automatic provisioning runs only after a source, scene and Discord ACL
    // precheck, then the resolved credential is independently verified.
    if (conversation && config.resolveWebhook) persona = undefined;
    if ((await precheck()).status !== "prechecked")
      return "discord_acl_blocked";
    if (conversation) {
      const npc = await getNpc(db, f.worldId, f.npcId);
      const parsed = baselineProfileSchema.safeParse(npc?.baselineProfile);
      const presentation =
        (parsed.success ? parsed.data.presentation : undefined) ??
        (config.native && npc?.canonicalName && npc.canonicalName.length <= 80
          ? { displayName: npc.canonicalName, avatarUrl: undefined }
          : undefined);
      if (!presentation) return "persona_unavailable";
      const webhook = config.resolveWebhook
        ? await config.resolveWebhook(authorize)
        : config.personaWebhook;
      if (!webhook) return "webhook_unavailable";
      persona = {
        webhook,
        name: presentation.displayName,
        avatarUrl: presentation.avatarUrl,
      };
      if ((await precheck()).status !== "prechecked")
        return "webhook_route_blocked";
      await conversation.memory.focus(message, f.npcId);
      diagnose({
        event: "raon_npc_resolution",
        outcome: conversation.via,
        npc: presentation.displayName,
        traceId: row.traceId,
      });
    } else {
      report("raon_npc_resolution", "sentinel");
    }
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
          "https://discord.com/api/v10/channels/" +
            (route.threadId ?? route.channelId) +
            "/typing",
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
      const previous = conversation
        ? await conversation.memory.history(f.npcId, player, botId)
        : null;
      const restricted = conversation
        ? await db.execute<{ claim_text: string }>(sql`
        select claim_text from npc_knowledge where world_id=${f.worldId} and npc_id=${f.npcId}
          and secrecy <> 'public' limit 65
      `)
        : null;
      if (restricted && restricted.rows.length > 64)
        return "disclosure_scope_too_large";
      const excludedText = restricted?.rows.map((r) => r.claim_text) ?? [];
      const redact = (value: string) =>
        excludedText.reduce((text, secret) => {
          const literal = secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
          return text.replace(new RegExp(literal, "giu"), "[withheld]");
        }, value);
      const safePairs = (pairs: { player: string; speech: string }[]) =>
        pairs.map((pair) => ({
          player: redact(pair.player),
          speech: redact(pair.speech),
        }));
      if (previous)
        diagnose({
          event: "raon_memory",
          outcome: "loaded",
          traceId: row.traceId,
          recent: previous.recent.length,
          excerpts: previous.excerpts.length,
        });
      const response = await pipeline.generateNpcResponse(
        f.worldId,
        f.npcId,
        row.id,
        {
          signal,
          beforeAttempt: async () =>
            (await authorize()) && (!config.native || (await permissions())),
          maxResponseChars: 600,
          dialogue: previous
            ? {
                request: redact(player).slice(0, 1200),
                history: safePairs(previous.recent),
                excerpts: safePairs(previous.excerpts),
                excludedText,
                natural: true,
              }
            : { request: player, history: [...history] },
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
              conversationSource: sourceBinding,
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
      if (
        delivery.status === "delivered" &&
        response.interaction.responseText
      ) {
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

export function createRaonSceneTurn(
  db: Omit<DatabaseClient["db"], "$client">,
  env: NodeJS.ProcessEnv,
  scene: RaonScene,
  config: Omit<
    TurnConfig,
    "fixture" | "playerId" | "policyId" | "verifyPermissions"
  > & {
    inactivityMs: number;
    policies: ReadonlyMap<string, string>;
    verifyPermissions: (playerId: string) => Promise<boolean>;
  },
) {
  const { worldKey, worldId, contextId, mappingId } = scene;
  const participants = new Map(
    scene.players.map((player) => {
      const scope = {
        worldKey,
        worldId,
        contextId,
        mappingId,
        playerEntityId: player.entityId,
      };
      const memory = createRaonConversation(db, scope, config.inactivityMs);
      const turns = new Map(
        scene.npcs.map((npc) => [
          npc.npcId,
          createRaonDevTurn(db, env, {
            ...config,
            fixture: { ...scope, npcId: npc.npcId, presenceId: npc.presenceId },
            hostEntityId: scene.players[0].entityId,
            playerId: player.discordId,
            policyId: () => config.policies.get(npc.npcId) ?? "",
            verifyPermissions: () => config.verifyPermissions(player.discordId),
          }),
        ]),
      );
      return [player.discordId, { memory, turns, player }];
    }),
  );
  return async (input: IncomingMessage, botId: string) => {
    const parsed = incomingMessageSchema.safeParse(input);
    if (!parsed.success) return "unsupported";
    const message = parsed.data;
    const actor = participants.get(message.authorId);
    const createdAt = discordMessageCreatedAt(message.sourceMessageId);
    if (
      !actor ||
      botId !== config.botId ||
      config.signal.aborted ||
      message.guildId !== config.route.guildId ||
      message.channelId !== config.route.channelId ||
      message.threadId !== config.route.threadId ||
      createdAt === null ||
      createdAt < config.startedAt ||
      createdAt > Date.now() ||
      Date.now() - createdAt > raonSourceAgeMs
    )
      return "ignored";
    // Closure writes only the mapped player's own focus and never authorizes a
    // response. Other routes, expired events and nonparticipants stop above.
    const resolution = await actor.memory.select(message, botId, scene.npcs);
    if (resolution.kind === "closed") {
      const active = await persistenceForClosure();
      if (!active || !(await config.verifyPermissions(message.authorId)))
        return "unauthorized";
      await actor.memory.focus(message, null);
    }
    if (resolution.kind !== "selected") {
      config.diagnose({ event: "raon_conversation", outcome: resolution.kind });
      return resolution.kind;
    }
    const turn = actor.turns.get(resolution.npcId);
    if (!turn) return "unavailable";
    return turn(message, botId, { ...resolution, memory: actor.memory });

    async function persistenceForClosure() {
      const result = await db.execute(sql`
        select 1 from discord_identities d join entities e on e.id=d.entity_id and e.world_id=d.world_id
        join interaction_contexts c on c.world_id=d.world_id
        join discord_context_mappings m on m.context_id=c.id and m.world_id=d.world_id
        where d.world_id=${worldId} and d.discord_user_id=${message.authorId}
          and d.entity_id=${actor!.player.entityId} and d.status='active'
          and d.mapping_type='player_character' and e.status='active' and e.entity_type='player_character'
          and c.id=${contextId} and c.status='active' and c.npc_intake_policy='mapped_players'
          and m.id=${mappingId} and m.status='active' and m.guild_id=${message.guildId}
          and m.channel_id=${message.channelId} and m.thread_id=${message.threadId}
      `);
      return result.rows.length === 1;
    }
  };
}
