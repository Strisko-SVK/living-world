import type { PoolClient } from "pg";
import { once } from "node:events";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { createDiscordAdapter } from "../adapters/discord/client.js";
import { verifyGatewayDevDatabase } from "../admin/gateway-dev-db.js";
import { gatewaySmokeBotId } from "../admin/discord-gateway-smoke.js";
import { getLlmConfig } from "../llm/config.js";
import { createDatabaseClient } from "../db/client.js";
import { normalizeAlias } from "../domains/entity/alias-normalizer.js";
import { snowflake, type SceneRoute } from "./registry.js";
import {
  createNativeNpcRuntime,
  type NativeDiscordPort,
  type NpcCommand,
} from "./runtime.js";

const namedActions = [
  "enable",
  "disable",
  "reassign",
  "status",
  "info",
  "scene",
] as const;
const generalActions = [
  "register",
  "register-here",
  "list",
  "bases",
  "install",
] as const;
const command = new SlashCommandBuilder()
  .setName("npc")
  .setDescription("Living World NPCs and scenes");
for (const name of generalActions) {
  const descriptions = {
    register: "Register this guild with Living World",
    "register-here": "Register this guild and approve this category",
    list: "List campaign NPCs",
    bases: "List accessible NPC bases",
    install: "Install new NPC templates from the catalog",
  };
  command.addSubcommand((sub) =>
    sub.setName(name).setDescription(descriptions[name]),
  );
}
for (const name of namedActions) {
  const descriptions = {
    enable: "Register this channel as an NPC base",
    disable: "Disable the selected NPC base",
    reassign: "Move the selected NPC base registration here",
    status: "Inspect this NPC base and availability",
    info: "Show the NPC affiliation and availability",
    scene: "Register a shared scene at this NPC home location",
  };
  command.addSubcommand((sub) =>
    sub
      .setName(name)
      .setDescription(descriptions[name])
      .addStringOption((option) =>
        option
          .setName("npc")
          .setDescription("NPC name or alias from /npc list")
          .setMaxLength(150)
          .setRequired(true),
      ),
  );
}
command.addSubcommand((sub) =>
  sub
    .setName("access")
    .setDescription("Manage Living World campaign access")
    .addUserOption((option) =>
      option.setName("user").setDescription("Discord member").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("role")
        .setDescription("Campaign permission")
        .setRequired(true)
        .addChoices(
          { name: "DM", value: "dm" },
          { name: "Player", value: "player" },
          { name: "Remove access", value: "remove" },
        ),
    ),
);

const options = (i: ChatInputCommandInteraction): NpcCommand => {
  const name = i.options.getSubcommand();
  for (const action of generalActions) if (name === action) return { action };
  for (const action of namedActions)
    if (name === action)
      return {
        action,
        alias: normalizeAlias(i.options.getString("npc", true)),
      };
  if (name === "access") {
    const role = i.options.getString("role", true);
    if (role === "dm" || role === "player" || role === "remove")
      return {
        action: "access",
        targetId: i.options.getUser("user", true).id,
        role,
      };
  }
  return { action: "invalid" };
};

export async function startNativeNpcGateway(
  env: NodeJS.ProcessEnv,
  diagnose: (event: { event: string; outcome?: string }) => void,
) {
  await verifyGatewayDevDatabase(env);
  const guildId = env.LW_DEV_GUILD_ID;
  const token = env.DISCORD_TOKEN;
  if (
    !guildId ||
    !snowflake.test(guildId) ||
    !token ||
    !/^\S{20,}$/u.test(token)
  )
    throw new Error("The allowed DEV guild and bot token are required.");
  // Opt in to the model-independent local endpoint. Existing RAON DEV setups
  // remain the default; only this trusted operator setting can switch providers.
  const inferenceProvider = env.LW_NPC_INFERENCE_PROVIDER ?? "raon";
  if (inferenceProvider !== "raon" && inferenceProvider !== "local")
    throw new Error("Unsupported native DEV inference provider.");
  const inferenceEnv = {
    ...env,
    LLM_PROVIDER: inferenceProvider,
    LLM_MODEL: env.LW_NPC_INFERENCE_MODEL ?? env.LLM_MODEL,
    LLM_MAX_OUTPUT_TOKENS:
      env.LW_NPC_OUTPUT_TOKENS ?? env.RAON_DEV_OUTPUT_TOKENS ?? "192",
  };
  const provider = getLlmConfig(inferenceEnv);
  if (!provider.enabled || provider.provider !== inferenceProvider)
    throw new Error("The native DEV Gateway requires a local inference profile.");

  const database = createDatabaseClient(env);
  const intents = ["Guilds", "GuildMessages", "MessageContent"] as const;
  const client = new Client({
    intents: intents.map((intent) => GatewayIntentBits[intent]),
    rest: { timeout: 5000, retries: 0 },
  });
  const controller = new AbortController();
  const { signal } = controller;
  const isExpected = (id: string) =>
    !signal.aborted &&
    id === guildId &&
    client.isReady() &&
    client.user?.id === gatewaySmokeBotId;

  const getAccess = async (
    route: SceneRoute,
    userId?: string,
    manage = false,
  ) => {
    if (!isExpected(route.guildId)) return null;
    const guild = client.guilds.cache.get(route.guildId);
    if (!guild) return null;
    const parent = await guild.channels.fetch(route.channelId, { force: true });
    if (
      parent?.type !== ChannelType.GuildText ||
      parent.guildId !== route.guildId
    )
      return null;
    await guild.roles.fetch();
    const bot = await guild.members.fetchMe({ force: true });
    const send = route.threadId
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages;
    const baseline = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      send,
    ];
    if (
      !parent
        .permissionsFor(bot)
        .has([
          ...baseline,
          ...(manage
            ? [
                PermissionFlagsBits.ManageWebhooks,
                PermissionFlagsBits.SendMessagesInThreads,
              ]
            : []),
        ])
    )
      return null;
    if (userId) {
      const member = await guild.members.fetch({ user: userId, force: true });
      if (member.user.bot || !parent.permissionsFor(member).has(baseline))
        return null;
    }
    const location = { categoryId: parent.parentId, ownerId: guild.ownerId };
    if (!route.threadId) return location;
    const thread = await guild.channels.fetch(route.threadId, { force: true });
    if (
      (thread?.type !== ChannelType.PublicThread &&
        thread?.type !== ChannelType.PrivateThread) ||
      thread.guildId !== route.guildId ||
      thread.parentId !== parent.id ||
      thread.archived !== false ||
      thread.locked !== false
    )
      return null;
    if (thread.type === ChannelType.PrivateThread) {
      // Both bot and sender must be actual members. Parent visibility and
      // elevated guild permissions do not widen a private thread's scope.
      for (const member of [bot.id, ...(userId ? [userId] : [])]) {
        const entry = await thread.members.fetch({ member, force: true });
        if (entry.id !== member) return null;
      }
    }
    return { ...location, threadOwnerId: thread.ownerId ?? undefined };
  };

  const port: NativeDiscordPort = {
    inspect: (route, userId, manage) =>
      getAccess(route, userId, manage).catch(() => null),
    async guildOwner(id, userId) {
      if (!isExpected(id)) return false;
      const guild = await client.guilds
        .fetch({ guild: id, force: true })
        .catch(() => null);
      return guild?.ownerId === userId;
    },
    async guildUser(id, userId) {
      if (!isExpected(id)) return false;
      const member = await client.guilds.cache
        .get(id)
        ?.members.fetch({ user: userId, force: true })
        .catch(() => null);
      return !!member && !member.user.bot;
    },
    async feedback(message, content) {
      if (!(await port.inspect(message, message.authorId)) || signal.aborted)
        return;
      const channel = await client.channels.fetch(
        message.threadId ?? message.channelId,
        { force: true },
      );
      if (
        channel?.type !== ChannelType.GuildText &&
        channel?.type !== ChannelType.PublicThread &&
        channel?.type !== ChannelType.PrivateThread
      )
        return;
      await channel.send({
        content,
        reply: {
          messageReference: message.sourceMessageId,
          failIfNotExists: true,
        },
        allowedMentions: { parse: [], repliedUser: false },
      });
    },
  };

  const runtime = createNativeNpcRuntime(database.db, {
    guildId,
    botId: gatewaySmokeBotId,
    token,
    env: inferenceEnv,
    signal,
    port,
    diagnose,
    startedAt: Date.now(),
  });
  let operational = false;
  const adapter = createDiscordAdapter(
    { enabled: true, token, intents: [...intents] },
    (message, botId) =>
      operational
        ? runtime.incoming(message, botId)
        : Promise.resolve("starting"),
    diagnose,
    client,
    true,
  );
  const pendingEvents = new Set<Promise<unknown>>();
  function handle(event: string, work: () => Promise<unknown>) {
    if (!operational || signal.aborted || pendingEvents.size >= 12) return;
    const task = work().catch(() =>
      diagnose({ event, outcome: "operation_failed" }),
    );
    pendingEvents.add(task);
    void task.finally(() => pendingEvents.delete(task));
  }

  client.on(Events.ThreadCreate, (thread) => {
    if (!thread.parentId || !thread.ownerId || !isExpected(thread.guildId))
      return;
    handle("native_thread_created", () =>
      runtime.threadCreated(
        {
          guildId: thread.guildId,
          channelId: thread.parentId!,
          threadId: thread.id,
        },
        thread.ownerId!,
      ),
    );
  });
  client.on(Events.ThreadDelete, (thread) => {
    if (!thread.parentId || !isExpected(thread.guildId)) return;
    handle("native_thread_deleted", () =>
      runtime.deleted({
        guildId: thread.guildId,
        channelId: thread.parentId!,
        threadId: thread.id,
      }),
    );
  });
  client.on(Events.ChannelDelete, (channel) => {
    if (channel.type === ChannelType.GuildText && isExpected(channel.guildId))
      handle("native_channel_deleted", () =>
        runtime.deleted({
          guildId: channel.guildId,
          channelId: channel.id,
          threadId: null,
        }),
      );
  });
  client.on(Events.InteractionCreate, (i) => {
    if (
      !i.isChatInputCommand() ||
      i.commandName !== "npc" ||
      !i.guildId ||
      !i.channelId ||
      i.user.bot ||
      !isExpected(i.guildId)
    )
      return;
    handle("native_slash", async () => {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const channel = await client.channels.fetch(i.channelId!, {
        force: true,
      });
      let route: SceneRoute | null = null;
      if (channel?.type === ChannelType.GuildText)
        route = { guildId: i.guildId!, channelId: channel.id, threadId: null };
      if (
        (channel?.type === ChannelType.PublicThread ||
          channel?.type === ChannelType.PrivateThread) &&
        channel.parentId
      )
        route = {
          guildId: i.guildId!,
          channelId: channel.parentId,
          threadId: channel.id,
        };
      const content = route
        ? await runtime.command(route, i.user.id, options(i))
        : "Use a supported Discord text channel or thread.";
      await i.editReply({ content, allowedMentions: { parse: [] } });
    });
  });

  let lease: PoolClient | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      operational = false;
      controller.abort();
      process.off("SIGINT", onStop);
      process.off("SIGTERM", onStop);
      try {
        await adapter.stop();
        await Promise.allSettled(pendingEvents);
        await runtime.drain();
      } finally {
        lease?.off("error", onStop);
        lease?.release(true);
        await database.close();
        diagnose({ event: "native_gateway", outcome: "stopped" });
      }
    })());
  const onStop = () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  };
  try {
    lease = await database.pool.connect();
    lease.on("error", onStop);
    const lock = await lease.query(
      "select pg_try_advisory_lock(8202601116) as locked",
    );
    if (lock.rows[0]?.locked !== true)
      throw new Error("A local Discord Gateway session is already running.");
    process.once("SIGINT", onStop);
    process.once("SIGTERM", onStop);
    await Promise.all([
      once(client, Events.ClientReady, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      }),
      adapter.start(),
    ]);
    if (!isExpected(guildId) || !client.guilds.cache.has(guildId))
      throw new Error("Expected bot and approved guild are unavailable.");
    const guild = await client.guilds.fetch(guildId);
    // Upsert only this application command. Preserve any other guild commands.
    await guild.commands.create(command.toJSON());
    operational = true;
    diagnose({ event: "native_gateway", outcome: "ready" });
    return { stop };
  } catch {
    await stop();
    throw new Error("Native Discord DEV Gateway startup failed.");
  }
}
