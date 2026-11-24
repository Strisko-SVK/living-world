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
import { setupRaonFixture } from "./raon-dev-fixture.js";
import { createRaonDevTurn } from "./raon-dev-turn.js";

export function readRaonSessionConfig(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  validateGatewayDevDatabaseEnv(env);
  const mode = args[0];
  if (
    args.length !== 1 ||
    !["--prepare", "--check-raon", "--run"].includes(mode)
  )
    throw new Error("Expected --prepare, --check-raon or --run.");

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
  const playerId = snowflake.parse(env.LW_PILOT_TEST_USER_ID);
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
    new Set([...Object.values(route), playerId, gatewaySmokeBotId]).size !==
      5 ||
    excluded.includes(route.channelId) ||
    excluded.includes(route.threadId)
  )
    throw new Error("Dedicated DEV route and single mapped player required.");
  if (
    mode === "--run" &&
    (env.LW_RAON_SESSION_APPROVED !== "true" ||
      !env.DISCORD_TOKEN ||
      !/^\S{20,}$/u.test(env.DISCORD_TOKEN))
  )
    throw new Error(
      "Set LW_RAON_SESSION_APPROVED=true locally and load the DEV bot token.",
    );
  return {
    mode,
    route,
    playerId,
    inferenceEnv,
    token: env.DISCORD_TOKEN ?? "",
  };
}
const snowflake = z.string().regex(/^[1-9][0-9]{16,19}$/u);

async function run(args: readonly string[], env: NodeJS.ProcessEnv) {
  const config = readRaonSessionConfig(args, env);
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
        await setupRaonFixture(db.db, config.route, config.playerId);
        diagnose({ event: "raon_fixture", outcome: "ready" });
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
      const fixture = await setupRaonFixture(
        db.db,
        config.route,
        config.playerId,
      );
      const policyScope = {
        worldId: fixture.worldId,
        contextId: fixture.contextId,
        npcId: fixture.npcId,
        presenceId: fixture.presenceId,
      };
      // Recover only a previous expired allow policy issued for this specific
      // pilot. An active policy, including a DM denial/hold, blocks startup.
      const [expired] = await db.db
        .select({ id: sceneSpeechPolicies.id })
        .from(sceneSpeechPolicies)
        .where(
          and(
            eq(sceneSpeechPolicies.worldId, fixture.worldId),
            eq(sceneSpeechPolicies.contextId, fixture.contextId),
            eq(sceneSpeechPolicies.npcId, fixture.npcId),
            eq(sceneSpeechPolicies.presenceId, fixture.presenceId),
            eq(sceneSpeechPolicies.issuerEntityId, fixture.playerEntityId),
            eq(sceneSpeechPolicies.decision, "allow_direct_speech"),
            isNull(sceneSpeechPolicies.revokedAt),
            sql`${sceneSpeechPolicies.expiresAt} <= clock_timestamp()`,
          ),
        )
        .limit(1);
      if (expired)
        await revokeHostSceneSpeechPolicy(db.db, policyScope, expired.id);

      const policy = await issueHostSceneSpeechPolicy(db.db, {
        ...policyScope,
        ttlMinutes: 30,
        issuerEntityId: fixture.playerEntityId,
        decision: "allow_direct_speech",
        activity: "free",
        perception: "aware",
        otherScene: "none",
      });
      if (policy.status !== "created")
        throw new Error(
          "The DEV scene host speech policy could not be issued.",
        );
      try {
        await openGateway(policy.id, fixture);
      } finally {
        try {
          const result = await revokeHostSceneSpeechPolicy(
            db.db,
            policyScope,
            policy.id,
          );
          const revoked =
            result.status === "revoked" || result.status === "already_revoked";
          diagnose({
            event: "raon_session",
            outcome: revoked ? "stopped" : "policy_revocation_unverified",
          });
          if (!revoked) process.exitCode = 1;
        } catch {
          diagnose({
            event: "raon_session",
            outcome: "policy_revocation_unverified",
          });
          process.exitCode = 1;
        }
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
    policyId: string,
    fixture: Awaited<ReturnType<typeof setupRaonFixture>>,
  ) {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
      rest: { timeout: 5000, retries: 0 },
    });
    const verifyPermissions = async () => {
      const guild = client.guilds.cache.get(config.route.guildId);
      if (!guild || client.user?.id !== gatewaySmokeBotId || signal.aborted)
        return false;
      const parent = await guild.channels.fetch(config.route.channelId, {
        force: true,
      });
      if (parent?.type !== ChannelType.GuildText) return false;
      await guild.roles.fetch();
      const bot = await guild.members.fetchMe({ force: true });
      return parent
        .permissionsFor(bot)
        .has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessagesInThreads,
        ]);
    };
    let ready = false;
    let pending = 0;
    let turns = 0;
    let queue = Promise.resolve();
    const turn = createRaonDevTurn(db.db, config.inferenceEnv, {
      fixture,
      route: config.route,
      playerId: config.playerId,
      botId: gatewaySmokeBotId,
      policyId,
      token: config.token,
      startedAt: Date.now(),
      signal,
      verifyPermissions,
      diagnose,
    });
    const gateway = createDiscordAdapter(
      {
        enabled: true,
        token: config.token,
        intents: ["Guilds", "GuildMessages"],
      },
      async (message, botId) => {
        if (
          !ready ||
          signal.aborted ||
          message.authorId !== config.playerId ||
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
          if (signal.aborted || turns >= 20) return;
          diagnose({
            event: "raon_queue",
            queueWaitMs: Math.round(performance.now() - queued),
          });
          const outcome = await turn(message, botId);
          if (
            ![
              "ignored",
              "duplicate",
              "event_conflict",
              "invalid_target",
              "invalid_trigger",
              "unauthorized",
              "unmapped",
            ].includes(outcome)
          )
            turns++;
          diagnose({
            event: "raon_turn",
            outcome,
            latencyMs: Math.round(performance.now() - queued),
          });
          if (turns >= 20) stop();
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

    const timeout = setTimeout(stop, 30 * 60 * 1000);
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
          await thread.members.fetch({ member: gatewaySmokeBotId, force: true });
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
      ready = true;
      diagnose({ event: "raon_session", outcome: "ready" });
      if (!signal.aborted) await once(signal, "abort");
    } finally {
      stop();
      clearTimeout(timeout);
      await gateway.stop();
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
