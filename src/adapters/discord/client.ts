import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import type { ApplicationConfig } from "../../config.js";
import type {
  Diagnostics,
  IncomingMessage,
} from "../../intake/discord-intake.js";
import { normalizeDiscordMessage } from "./message.js";

type ClientPort = Pick<Client, "on" | "off" | "login" | "destroy" | "user">;

export function createDiscordAdapter(
  config: Pick<ApplicationConfig["discord"], "enabled" | "token" | "intents">,
  intake: (message: IncomingMessage, botId: string) => Promise<unknown>,
  diagnose: Diagnostics = () => {},
  client: ClientPort = new Client({
    intents: config.intents.map((name) => GatewayIntentBits[name]),
  }),
) {
  const pending = new Set<Promise<void>>();
  let stopping = false;
  let started = false;
  let stopPromise: Promise<void> | undefined;
  const onMessage = (message: Message) => {
    if (stopping || !client.user?.id) return;
    const botId = client.user.id;
    const work = (async () => {
      try {
        const normalized = normalizeDiscordMessage(message);
        if (normalized) await intake(normalized, botId);
      } catch {
        diagnose({ event: "discord_message_error" });
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  const onReady = () => diagnose({ event: "discord_ready" });
  const onError = () => diagnose({ event: "discord_connection_error" });
  const onDisconnect = () => diagnose({ event: "discord_disconnected" });
  const onResume = () => diagnose({ event: "discord_resumed" });
  const listeners = () => {
    client.on(Events.MessageCreate, onMessage);
    client.on(Events.ClientReady, onReady);
    client.on(Events.Error, onError);
    client.on(Events.ShardError, onError);
    client.on(Events.ShardDisconnect, onDisconnect);
    client.on(Events.ShardResume, onResume);
  };
  const removeListeners = () => {
    client.off(Events.MessageCreate, onMessage);
    client.off(Events.ClientReady, onReady);
    client.off(Events.Error, onError);
    client.off(Events.ShardError, onError);
    client.off(Events.ShardDisconnect, onDisconnect);
    client.off(Events.ShardResume, onResume);
  };
  const stop = () => {
    stopPromise ??= (async () => {
      stopping = true;
      client.off(Events.MessageCreate, onMessage);
      try {
        await client.destroy();
      } finally {
        await Promise.allSettled(pending);
        removeListeners();
        diagnose({ event: "discord_stopped" });
      }
    })();
    return stopPromise;
  };
  return {
    async start() {
      if (!config.enabled || !config.token)
        throw new Error("Discord is not configured for startup.");
      if (started || stopping)
        throw new Error("Discord adapter cannot be started again.");
      started = true;
      listeners();
      diagnose({ event: "discord_starting" });
      try {
        await client.login(config.token);
      } catch {
        await stop();
        throw new Error("Discord startup failed.");
      }
    },
    stop,
  };
}
