import { EventEmitter } from "node:events";
import { Client, Events, type Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  connectGatewaySmoke,
  gatewaySmokeBotId,
  matchesGatewaySmokeTarget,
  parseGatewaySmokeMode,
  validateGatewaySmokeConfig,
} from "./discord-gateway-smoke.js";

const guildId = "1566911648701223053";
const parentId = "1566913668795469934";
const threadId = "1566914038158459090";
const token = "synthetic-not-a-real-discord-token";
const env = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: "a".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD: "b".repeat(64),
  DATABASE_URL:
    "postgresql://lw_gateway_dev:" +
    "b".repeat(64) +
    "@127.0.0.1:55432/living_world_gateway_dev",
  LW_DEV_GUILD_ID: guildId,
  LW_DEV_PARENT_CHANNEL_ID: parentId,
  LW_DEV_THREAD_ID: threadId,
  LW_DEV_BOT_USER_ID: gatewaySmokeBotId,
  DISCORD_TOKEN: token,
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
};

function message(overrides: Record<string, unknown> = {}): Message {
  return {
    partial: false,
    author: { id: "1999999999999999999", bot: false },
    webhookId: null,
    system: false,
    guildId,
    channelId: threadId,
    content: "Sensitive test content must never be logged",
    channel: {
      isThread: () => true,
      parentId,
      send: vi.fn(),
    },
    reply: vi.fn(),
    ...overrides,
  } as unknown as Message;
}

describe("Gateway smoke fail-closed preflight", () => {
  it("accepts the dedicated DB and exact Discord identities with modes disabled", () => {
    expect(validateGatewaySmokeConfig(env)).toEqual({
      guildId,
      parentId,
      threadId,
      botId: gatewaySmokeBotId,
      token,
    });
  });

  it("rejects wrong identity, target or enabled execution modes", () => {
    for (const override of [
      { LW_DEV_BOT_USER_ID: "1555555555555555555" },
      { DISCORD_TOKEN: "" },
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { NODE_ENV: "production" },
      { LW_DEV_GUILD_ID: "" },
      { LW_DEV_PARENT_CHANNEL_ID: "" },
      { LW_DEV_THREAD_ID: "" },
      { DATABASE_URL: env.DATABASE_URL.replace("55432", "5432") },
      { DATABASE_URL: env.DATABASE_URL.replace("gateway_dev", "production") },
    ]) {
      expect(() => validateGatewaySmokeConfig({ ...env, ...override })).toThrow();
    }
  });

  it("defaults to offline preflight and gates connection by exact guild and scope", () => {
    expect(parseGatewaySmokeMode([], guildId)).toBe("preflight");
    expect(parseGatewaySmokeMode(["--preflight"], guildId)).toBe("preflight");
    expect(
      parseGatewaySmokeMode(
        ["--connect", "--confirm-guild", guildId, "--inbound-only"],
        guildId,
      ),
    ).toBe("connect");
    for (const args of [
      ["--connect"],
      ["--connect", "--confirm-guild", "1555555555555555555", "--inbound-only"],
      ["--connect", "--confirm-guild", guildId],
      ["--connect", "--confirm-guild", guildId, "--send"],
    ]) {
      expect(() => parseGatewaySmokeMode(args, guildId)).toThrow();
    }
  });

  it("accepts only inbound human messages in the exact public thread", () => {
    const config = { guildId, parentId, threadId };
    expect(matchesGatewaySmokeTarget(message(), config)).toBe(true);
    for (const override of [
      { guildId: "1666666666666666666" },
      { channelId: parentId },
      { author: { id: "bot", bot: true } },
      { webhookId: "webhook" },
      { partial: true },
      { system: true },
      { channel: { isThread: () => true, parentId: "other" } },
      { channel: { isThread: () => false, parentId } },
    ]) {
      expect(matchesGatewaySmokeTarget(message(override), config)).toBe(false);
    }
  });
});

describe("Gateway smoke transport lifecycle (offline fake)", () => {
  it("logs only safe event names, does not send, and cleans up after one target event", async () => {
    const client = Object.assign(new EventEmitter(), {
      user: { id: gatewaySmokeBotId },
      guilds: { cache: new Map([[guildId, {}]]) },
      login: vi.fn().mockResolvedValue(token),
      destroy: vi.fn().mockResolvedValue(undefined),
    });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const config = validateGatewaySmokeConfig(env);
    try {
      const running = connectGatewaySmoke(config, client as unknown as Client);
      await Promise.resolve();
      client.emit(Events.ClientReady);
      client.emit(
        Events.MessageCreate,
        message({ channelId: "1666666666666666666" }),
      );
      client.emit(Events.MessageCreate, message());
      await running;
      expect(client.login).toHaveBeenCalledWith(token);
      expect(client.destroy).toHaveBeenCalledOnce();
      expect(log.mock.calls.map((c) => c[0])).toEqual([
        JSON.stringify({ event: "gateway_smoke_ready" }),
        JSON.stringify({ event: "gateway_smoke_target_message" }),
        JSON.stringify({ event: "gateway_smoke_stopped" }),
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("Sensitive test content");
      expect(JSON.stringify(log.mock.calls)).not.toContain(token);
      expect((message().channel as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
      expect(client.listenerCount(Events.MessageCreate)).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it("fails closed when authenticated bot identity does not match", async () => {
    const client = Object.assign(new EventEmitter(), {
      user: { id: "1666666666666666666" },
      guilds: { cache: new Map([[guildId, {}]]) },
      login: vi.fn().mockResolvedValue(token),
      destroy: vi.fn().mockResolvedValue(undefined),
    });
    const running = connectGatewaySmoke(
      validateGatewaySmokeConfig(env),
      client as unknown as Client,
    );
    await Promise.resolve();
    client.emit(Events.ClientReady);
    await expect(running).rejects.toThrow("mismatch");
    expect(client.destroy).toHaveBeenCalledOnce();
  });
});
