import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} from "discord.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { createDiscordAdapter } from "../adapters/discord/client.js";
import { createDatabaseClient } from "../db/client.js";
import { sceneSpeechPolicies } from "../db/schema/index.js";
import {
  issueHostSceneSpeechPolicy,
  revokeHostSceneSpeechPolicy,
} from "../communication/scene-speech-policies.repository.js";
import { createLlmService } from "../llm/composition.js";
import { getLlmConfig } from "../llm/config.js";
import { validateNpcSpeech } from "../response/prompt.js";
import { gatewaySmokeBotId } from "./discord-gateway-smoke.js";
import {
  validateGatewayDevDatabaseEnv,
  verifyGatewayDevDatabase,
} from "./gateway-dev-db.js";
import {
  setupRaonScene,
  raonWorldKey,
  type RaonScene,
} from "./raon-dev-fixture.js";
import { quartermasterWorldPrefix } from "./quartermaster-profile.js";
import { createRaonWebhookManager } from "./raon-webhooks.js";
import { runRaonBenchmark } from "./raon-dev-benchmark.js";
import { createRaonDevTurn, createRaonSceneTurn } from "./raon-dev-turn.js";
import { readNpcWebhook } from "./dev-first-reply-transport.js";

export function readRaonSessionConfig(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  validateGatewayDevDatabaseEnv(env);
  const mode = args[0];
  if (
    args.length !== 1 ||
    !["--prepare", "--check-raon", "--benchmark", "--run"].includes(mode)
  )
    throw new Error("Expected --prepare, --check-raon, --benchmark or --run.");

  const inferenceEnv = {
    ...env,
    LLM_PROVIDER: "raon",
    LLM_MAX_OUTPUT_TOKENS: env.RAON_DEV_OUTPUT_TOKENS ?? "192",
  };
  const llm = getLlmConfig(inferenceEnv);
  if (!llm.enabled || llm.provider !== "raon")
    throw new Error("Raon configuration required.");
  const route = z
    .object({ guildId: snowflake, channelId: snowflake, threadId: snowflake })
    .parse({
      guildId: env.LW_DEV_GUILD_ID,
      channelId: env.LW_RAON_PARENT_ID,
      threadId: env.LW_RAON_THREAD_ID,
    });
  const advanced =
    z
      .enum(["sentinel", "quartermaster"])
      .default("sentinel")
      .parse(env.LW_RAON_SCENE) === "quartermaster";
  const playerId = snowflake.parse(env.LW_PILOT_TEST_USER_ID);
  const playerIds = [
    playerId,
    ...(advanced && env.LW_RAON_ADDITIONAL_PLAYER_IDS
      ? env.LW_RAON_ADDITIONAL_PLAYER_IDS.split(",").map((value) =>
          snowflake.parse(value.trim()),
        )
      : []),
  ];
  const inactivityMs =
    z.coerce
      .number()
      .int()
      .min(1)
      .max(60)
      .default(10)
      .parse(env.LW_RAON_INACTIVITY_MINUTES) * 60_000;
  if (advanced && llm.contextTokens !== 4096)
    throw new Error("Quartermaster DEV requires a 4096-token RAON context.");
  const intents = advanced
    ? (["Guilds", "GuildMessages", "MessageContent"] as const)
    : (["Guilds", "GuildMessages"] as const);
  const excluded = [
    env.LW_DEV_PARENT_CHANNEL_ID,
    env.LW_DEV_THREAD_ID,
    env.LW_PILOT_PARENT_CHANNEL_ID,
    env.LW_PILOT_THREAD_ID,
    env.LW_NPC_E2E_PARENT_CHANNEL_ID,
    env.LW_NPC_E2E_THREAD_ID,
    env.LW_FIRST_REPLY_PREVIOUS_PARENT_ID,
    env.LW_FIRST_REPLY_PREVIOUS_THREAD_ID,
    env.LW_FIRST_REPLY_PARENT_ID,
    env.LW_FIRST_REPLY_THREAD_ID,
  ];
  if (
    playerIds.length > 4 ||
    new Set([...Object.values(route), ...playerIds, gatewaySmokeBotId]).size !==
      playerIds.length + 4 ||
    excluded.includes(route.channelId) ||
    excluded.includes(route.threadId)
  )
    throw new Error(
      "Dedicated DEV route and distinct mapped players required.",
    );
  if (
    mode === "--run" &&
    (env.LW_RAON_SESSION_APPROVED !== "true" ||
      !env.DISCORD_TOKEN ||
      !/^\S{20,}$/u.test(env.DISCORD_TOKEN))
  )
    throw new Error(
      "Set LW_RAON_SESSION_APPROVED=true locally and load the DEV bot token.",
    );
  const webhook = env.LW_RAON_NPC_WEBHOOK_URL
    ? readNpcWebhook(env.LW_RAON_NPC_WEBHOOK_URL)
    : undefined;
  return {
    mode,
    advanced,
    playerIds,
    intents,
    inactivityMs,
    worldKey: advanced
      ? quartermasterWorldPrefix + route.threadId
      : raonWorldKey,
    route,
    webhook,
    playerId,
    inferenceEnv,
    token: env.DISCORD_TOKEN ?? "",
  };
}
const snowflake = z.string().regex(/^[1-9][0-9]{16,19}$/u);

async function run(args: readonly string[], env: NodeJS.ProcessEnv) {
  const config = readRaonSessionConfig(args, env);
  const loadScene = () =>
    setupRaonScene(db.db, config.route, config.playerIds, config.worldKey);
  await verifyGatewayDevDatabase(env);
  const db = createDatabaseClient(env);
  const diagnose = (event: {
    event: string;
    outcome?: string;
    reason?: string;
    queueWaitMs?: number;
    latencyMs?: number;
  }) => console.info(JSON.stringify(event));
  const controller = new AbortController();
  const signal = controller.signal;
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (config.mode !== "--run") {
      if (config.mode === "--prepare") {
        await loadScene();
        diagnose({ event: "raon_fixture", outcome: "ready" });
      } else if (config.mode === "--benchmark") {
        await runRaonBenchmark(
          createLlmService(db.db, config.inferenceEnv),
          signal,
        );
      } else {
        await checkRaon();
      }
      return;
    }

    // Hold an exclusive connection-level lock for the entire pilot. If this
    // connection is lost, abort instead of continuing alongside another session.
    const lease = await db.pool.connect();
    lease.on("error", stop);
    try {
      const locked = await lease.query(
        "select pg_try_advisory_lock(8202601116) as locked",
      );
      if (locked.rows[0]?.locked !== true)
        throw new Error("A Raon session already holds the local DEV lock.");
      await checkRaon();
      const scene = await loadScene();
      const scopes = scene.npcs.map((npc) => ({
        worldId: scene.worldId,
        contextId: scene.contextId,
        npcId: npc.npcId,
        presenceId: npc.presenceId,
      }));
      const policyIds = new Map<string, string>();
      const issuerEntityId = scene.players[0].entityId;
      const issue = async (scope: (typeof scopes)[number]) => {
        const result = await issueHostSceneSpeechPolicy(db.db, {
          ...scope,
          ttlMinutes: 30,
          issuerEntityId,
          raonSessionManaged: true,
          decision: "allow_direct_speech",
          activity: "free",
          perception: "aware",
          otherScene: "none",
        });
        if (result.status !== "created") {
          diagnose({
            event: "raon_policy",
            outcome: "blocked",
            reason: result.status,
          });
          if (
            config.advanced &&
            ["already_open", "scene_denied"].includes(result.status)
          )
            return;
          throw new Error(
            "The scoped DEV scene speech policy could not be issued.",
          );
        }
        policyIds.set(scope.npcId, result.id);
      };
      try {
        for (const scope of scopes) {
          // The exclusive session lease is already held. Recover only our
          // exact fixture's runner-owned allow, or the prior expired Sentinel
          // allow. A hold, denial or unrelated allow is preserved.
          const [orphan] = await db.db
            .select({ id: sceneSpeechPolicies.id })
            .from(sceneSpeechPolicies)
            .where(
              and(
                eq(sceneSpeechPolicies.worldId, scope.worldId),
                eq(sceneSpeechPolicies.contextId, scope.contextId),
                eq(sceneSpeechPolicies.npcId, scope.npcId),
                eq(sceneSpeechPolicies.presenceId, scope.presenceId),
                eq(sceneSpeechPolicies.issuerEntityId, issuerEntityId),
                eq(sceneSpeechPolicies.issuerRole, "host_operator"),
                eq(sceneSpeechPolicies.decision, "allow_direct_speech"),
                eq(sceneSpeechPolicies.activity, "free"),
                eq(sceneSpeechPolicies.perception, "aware"),
                eq(sceneSpeechPolicies.otherScene, "none"),
                isNull(sceneSpeechPolicies.revokedAt),
                sql`${sceneSpeechPolicies.issuedBy}=current_user`,
                config.advanced
                  ? eq(sceneSpeechPolicies.raonSessionManaged, true)
                  : sql`(${sceneSpeechPolicies.raonSessionManaged} OR ${sceneSpeechPolicies.expiresAt} <= clock_timestamp())`,
              ),
            )
            .limit(1);
          if (orphan) {
            const result = await revokeHostSceneSpeechPolicy(
              db.db,
              scope,
              orphan.id,
            );
            if (result.status !== "revoked")
              throw new Error("Runner policy changed during recovery.");
            diagnose({ event: "raon_policy", outcome: "recovered" });
          }
          await issue(scope);
        }
        if (!policyIds.size)
          throw new Error("No NPC is available in the approved scene.");
        await openGateway(scene, policyIds, async () => {
          signal.throwIfAborted();
          await lease.query("select 1");
          for (const scope of scopes) {
            signal.throwIfAborted();
            const id = policyIds.get(scope.npcId);
            if (!id) continue;
            const previous = await revokeHostSceneSpeechPolicy(
              db.db,
              scope,
              id,
            );
            policyIds.delete(scope.npcId);
            if (previous.status !== "revoked") {
              if (
                config.advanced &&
                ["already_revoked", "not_found"].includes(previous.status)
              ) {
                diagnose({
                  event: "raon_policy",
                  outcome: "externally_changed",
                  reason: previous.status,
                });
                continue;
              }
              throw new Error("The DEV policy could not be renewed.");
            }
            signal.throwIfAborted();
            await issue(scope);
          }
          diagnose({ event: "raon_policy", outcome: "renewed" });
        });
      } finally {
        let revoked = true;
        for (const scope of scopes) {
          const id = policyIds.get(scope.npcId);
          if (!id) continue;
          try {
            const result = await revokeHostSceneSpeechPolicy(db.db, scope, id);
            revoked &&=
              result.status === "revoked" ||
              result.status === "already_revoked";
          } catch {
            revoked = false;
          }
        }
        diagnose({
          event: "raon_session",
          outcome: revoked ? "stopped" : "policy_revocation_unverified",
        });
        if (!revoked) process.exitCode = 1;
      }
    } finally {
      lease.off("error", stop);
      // Destroy the leased connection so the advisory lock is always dropped.
      lease.release(true);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await db.close();
  }

  async function checkRaon() {
    const result = await createLlmService(
      db.db,
      config.inferenceEnv,
      (event) => {
        diagnose({ ...event, event: "raon_preflight" });
      },
    )({
      traceId: randomUUID(),
      instructions: {
        system:
          'Write a short greeting. Reply as JSON with only the key "speech".',
      },
      messages: [{ role: "user", content: "Say hello." }],
      responseFormat: {
        name: "raon_preflight",
        schema: {
          type: "object",
          properties: { speech: { type: "string" } },
          required: ["speech"],
          additionalProperties: false,
        },
      },
      signal,
    });
    if (!result.ok || !validateNpcSpeech(result.text, 600, []))
      throw new Error(
        "Raon preflight failed. Check tunnel, runtime, schema and actual token counts.",
      );
  }

  async function openGateway(
    scene: RaonScene,
    policies: ReadonlyMap<string, string>,
    renewPolicy: () => Promise<void>,
  ) {
    const client = new Client({
      intents: config.intents.map((intent) => GatewayIntentBits[intent]),
      rest: { timeout: 5000, retries: 0 },
    });
    const verifyPermissions = async (
      playerId?: string,
      manageWebhooks = false,
    ) => {
      const guild = client.guilds.cache.get(config.route.guildId);
      if (
        !guild ||
        !client.isReady() ||
        client.user?.id !== gatewaySmokeBotId ||
        signal.aborted
      )
        return false;
      const parent = await guild.channels.fetch(config.route.channelId, {
        force: true,
      });
      if (parent?.type !== ChannelType.GuildText) return false;
      await guild.roles.fetch();
      const bot = await guild.members.fetchMe({ force: true });
      if (
        !parent
          .permissionsFor(bot)
          .has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessagesInThreads,
            ...(manageWebhooks ? [PermissionFlagsBits.ManageWebhooks] : []),
          ])
      )
        return false;
      if (!playerId || !config.advanced) return true;
      const player = await guild.members.fetch({ user: playerId, force: true });
      if (
        !parent
          .permissionsFor(player)
          .has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessagesInThreads,
          ])
      )
        return false;
      const thread = await client.channels.fetch(config.route.threadId, {
        force: true,
      });
      if (thread?.type === ChannelType.PublicThread) return true;
      if (thread?.type !== ChannelType.PrivateThread) return false;
      const member = await thread.members
        .fetch({ member: playerId, force: true })
        .catch(() => null);
      return member !== null;
    };
    let ready = false;
    let pending = 0;
    let queue = Promise.resolve();
    const common = {
      route: config.route,
      botId: gatewaySmokeBotId,
      token: config.token,
      personaWebhook: config.webhook,
      startedAt: Date.now(),
      signal,
      diagnose,
    };
    const legacy = scene.npcs[0];
    const turn = config.advanced
      ? createRaonSceneTurn(db.db, config.inferenceEnv, scene, {
          ...common,
          policies,
          inactivityMs: config.inactivityMs,
          verifyPermissions,
          resolveWebhook: createRaonWebhookManager({
            ...common,
            manual: config.webhook,
            canManage: () => verifyPermissions(undefined, true),
          }),
        })
      : createRaonDevTurn(db.db, config.inferenceEnv, {
          ...common,
          playerId: config.playerId,
          policyId: () => policies.get(legacy.npcId) ?? "",
          fixture: {
            ...scene,
            npcId: legacy.npcId,
            presenceId: legacy.presenceId,
            playerEntityId: scene.players[0].entityId,
          },
          verifyPermissions,
        });
    const gateway = createDiscordAdapter(
      {
        enabled: true,
        token: config.token,
        intents: [...config.intents],
      },
      async (message, botId) => {
        if (
          !ready ||
          signal.aborted ||
          !config.playerIds.includes(message.authorId) ||
          message.guildId !== config.route.guildId ||
          message.channelId !== config.route.channelId ||
          message.threadId !== config.route.threadId
        )
          return;
        if (pending >= 4) {
          diagnose({ event: "raon_queue", outcome: "full" });
          return;
        }
        const queued = performance.now();
        pending++;
        const work = queue.then(async () => {
          if (signal.aborted) return;
          diagnose({
            event: "raon_queue",
            queueWaitMs: Math.round(performance.now() - queued),
          });
          const outcome = await turn(message, botId);
          diagnose({
            event: "raon_turn",
            outcome: outcome ?? "unaccepted",
            latencyMs: Math.round(performance.now() - queued),
          });
        });
        queue = work.catch(() => {
          diagnose({ event: "raon_turn", outcome: "operation_failed" });
          stop();
        });
        await work.finally(() => pending--);
      },
      diagnose,
      client,
      true,
    );

    let renewal: ReturnType<typeof setInterval> | undefined;
    try {
      signal.throwIfAborted();
      await Promise.all([
        once(client, Events.ClientReady, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        }),
        gateway.start(),
      ]);
      if (!(await verifyPermissions())) {
        diagnose({
          event: "raon_startup",
          outcome: "blocked",
          reason: "bot_guild_parent_or_acl",
        });
        throw new Error(
          "Wrong bot account, DEV guild, parent or send permissions.",
        );
      }
      const thread = await client.channels.fetch(config.route.threadId, {
        force: true,
      });
      if (
        (thread?.type !== ChannelType.PublicThread &&
          thread?.type !== ChannelType.PrivateThread) ||
        thread.parentId !== config.route.channelId ||
        thread.guildId !== config.route.guildId ||
        thread.archived ||
        thread.locked
      ) {
        diagnose({
          event: "raon_startup",
          outcome: "blocked",
          reason: "thread_type_route_or_state",
        });
        throw new Error("The approved DEV thread is unavailable.");
      }
      if (thread.type === ChannelType.PrivateThread) {
        try {
          await thread.members.fetch({
            member: gatewaySmokeBotId,
            force: true,
          });
        } catch {
          diagnose({
            event: "raon_startup",
            outcome: "blocked",
            reason: "private_thread_membership",
          });
          throw new Error(
            "The approved private thread membership is unavailable.",
          );
        }
      }
      if (config.webhook) {
        try {
          const res = await fetch(config.webhook.url, {
            redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          });
          if (!res.ok || res.redirected)
            throw new Error("Webhook unavailable.");
          const metadata = z
            .object({
              id: snowflake,
              type: z.literal(1),
              guild_id: snowflake,
              channel_id: snowflake,
            })
            .parse(await res.json());
          if (
            metadata.id !== config.webhook.id ||
            metadata.guild_id !== config.route.guildId ||
            metadata.channel_id !== config.route.channelId
          )
            throw new Error("Webhook route mismatch.");
        } catch {
          diagnose({
            event: "raon_startup",
            outcome: "blocked",
            reason: "npc_webhook_unavailable_or_wrong_route",
          });
          throw new Error("Dedicated NPC webhook unavailable.");
        }
      }
      if (
        config.advanced &&
        !config.webhook &&
        !(await verifyPermissions(undefined, true))
      ) {
        diagnose({
          event: "raon_startup",
          outcome: "blocked",
          reason: "manage_webhooks_required",
        });
        throw new Error(
          "The bot needs Manage Webhooks on the approved parent channel.",
        );
      }
      diagnose({
        event: "raon_persona",
        outcome: config.webhook
          ? "manual_webhook"
          : config.advanced
            ? "managed_webhook"
            : "bot_reply",
      });
      ready = true;
      diagnose({ event: "raon_session", outcome: "ready" });
      // Rotate the bounded policy on the same serial queue as dialogue. No
      // in-flight turn changes policy IDs; the global DB guard stays intact.
      renewal = setInterval(
        () => {
          if (signal.aborted) return;
          queue = queue
            .then(async () => {
              if (!signal.aborted) await renewPolicy();
            })
            .catch(() => {
              diagnose({
                event: "raon_policy",
                outcome: "renewal_failed",
              });
              stop();
            });
        },
        20 * 60 * 1000,
      );
      if (!signal.aborted) await once(signal, "abort");
    } finally {
      stop();
      if (renewal) clearInterval(renewal);
      await gateway.stop();
      await queue;
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void run(process.argv.slice(2), process.env).catch(() => {
    console.error(
      "Raon DEV command stopped. Check the last diagnostic and the local runbook.",
    );
    process.exitCode = 1;
  });
}
