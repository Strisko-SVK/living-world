import { pathToFileURL } from "node:url";
import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import { validateDevFixtureEnvironment } from "./discord-dev-fixture.js";
import { validateGatewayDevDatabaseEnv } from "./gateway-dev-db.js";

export const gatewaySmokeBotId = "1566909036899868712";

export type GatewaySmokeConfig = {
  guildId: string;
  parentId: string;
  threadId: string;
  botId: string;
  token: string;
};

export function validateGatewaySmokeConfig(
  environment: NodeJS.ProcessEnv,
): GatewaySmokeConfig {
  validateGatewayDevDatabaseEnv(environment);
  const route = validateDevFixtureEnvironment(environment);
  if (environment.DISCORD_ENABLED !== "false")
    throw new Error("Normal Discord runtime must remain disabled.");
  if (environment.LW_DEV_BOT_USER_ID !== gatewaySmokeBotId)
    throw new Error("The expected isolated DEV bot identity is missing.");
  const token = environment.DISCORD_TOKEN;
  if (!token || !/^\S{20,}$/u.test(token))
    throw new Error("A private DEV bot token is required.");
  return {
    guildId: route.guildId,
    parentId: route.channelId,
    threadId: route.threadId,
    botId: gatewaySmokeBotId,
    token,
  };
}

export function parseGatewaySmokeMode(
  args: readonly string[],
  guildId: string,
): "preflight" | "connect" {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preflight"))
    return "preflight";
  if (
    args.length === 4 &&
    args[0] === "--connect" &&
    args[1] === "--confirm-guild" &&
    args[2] === guildId &&
    args[3] === "--inbound-only"
  )
    return "connect";
  throw new Error("Gateway connection requires exact guild confirmation.");
}

export function matchesGatewaySmokeTarget(
  message: Pick<
    Message,
    | "partial"
    | "author"
    | "webhookId"
    | "system"
    | "guildId"
    | "channelId"
    | "channel"
  >,
  config: Pick<GatewaySmokeConfig, "guildId" | "parentId" | "threadId">,
): boolean {
  return (
    !message.partial &&
    !message.author.bot &&
    !message.webhookId &&
    !message.system &&
    message.guildId === config.guildId &&
    message.channelId === config.threadId &&
    message.channel.isThread() &&
    message.channel.parentId === config.parentId
  );
}

// Transport-only: does not import the application runtime, intake persistence,
// LLM, webhook delivery, or any send/reply/edit API. Logs no message contents,
// authors, message IDs or bot token. It never mutates the database.
export async function connectGatewaySmoke(
  config: GatewaySmokeConfig,
  client: Client = new Client({
    // MessageCreate metadata is sufficient for this first smoke.
    // Do not request privileged MessageContent until a later authorized phase.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  }),
): Promise<void> {
  let ready = false;
  let complete!: () => void;
  let fail!: (error: Error) => void;
  const observed = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  const timeout = setTimeout(
    () => fail(new Error("No target message observed before smoke timeout.")),
    90_000,
  );
  const onSignal = () => fail(new Error("Smoke interrupted."));
  const onReady = () => {
    if (
      client.user?.id !== config.botId ||
      !client.guilds.cache.has(config.guildId)
    ) {
      fail(new Error("Authenticated bot or DEV guild mismatch."));
      return;
    }
    ready = true;
    console.info(JSON.stringify({ event: "gateway_smoke_ready" }));
  };
  const onMessage = (message: Message) => {
    if (!ready || !matchesGatewaySmokeTarget(message, config)) return;
    console.info(JSON.stringify({ event: "gateway_smoke_target_message" }));
    complete();
  };
  const onError = () => fail(new Error("Discord Gateway transport error."));
  client.on(Events.ClientReady, onReady);
  client.on(Events.MessageCreate, onMessage);
  client.on(Events.Error, onError);
  client.on(Events.ShardError, onError);
  client.on(Events.ShardDisconnect, onError);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await client.login(config.token);
    await observed;
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    client.off(Events.ClientReady, onReady);
    client.off(Events.MessageCreate, onMessage);
    client.off(Events.Error, onError);
    client.off(Events.ShardError, onError);
    client.off(Events.ShardDisconnect, onError);
    await client.destroy();
    console.info(JSON.stringify({ event: "gateway_smoke_stopped" }));
  }
}

async function main(): Promise<void> {
  const config = validateGatewaySmokeConfig(process.env);
  const mode = parseGatewaySmokeMode(process.argv.slice(2), config.guildId);
  if (mode === "preflight") {
    console.info(JSON.stringify({ event: "gateway_smoke_config_valid" }));
    return;
  }
  await connectGatewaySmoke(config);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch(() => {
    // Never log raw Discord SDK errors, secrets, message bodies or env values.
    console.error(JSON.stringify({ event: "gateway_smoke_failed" }));
    process.exitCode = 1;
  });
}
