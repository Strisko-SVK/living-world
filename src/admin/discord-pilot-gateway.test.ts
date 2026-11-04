import { EventEmitter } from "node:events";
import {
  ChannelType,
  Client,
  Events,
  MessageType,
  type Message,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  connectOnePilotMessage,
  parsePilotInboundArguments,
  pickPilotInboundMessage,
  pilotInboundScope,
  validatePilotInboundEnvironment,
  type PilotInboundConfig,
} from "./discord-pilot-gateway.js";

const botId = "1566909036899868712";
const playerId = "1766911648701223053";
const guildId = "1566911648701223053";
const parentId = "1567604837309350030";
const threadId = "1567605016603271208";
const token = "synthetic-not-a-real-discord-token";
const dbPassword = "b".repeat(64);
const environment: NodeJS.ProcessEnv = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: "a".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD: dbPassword,
  DATABASE_URL:
    "postgresql://lw_gateway_dev:" +
    dbPassword +
    "@127.0.0.1:55432/living_world_gateway_dev",
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
  LW_DEV_GUILD_ID: guildId,
  LW_DEV_PARENT_CHANNEL_ID: "1566913668795469934",
  LW_DEV_THREAD_ID: "1566914038158459090",
  LW_PILOT_PARENT_CHANNEL_ID: parentId,
  LW_PILOT_THREAD_ID: threadId,
  LW_PILOT_TEST_USER_ID: playerId,
  LW_DEV_BOT_USER_ID: botId,
  DISCORD_TOKEN: token,
};
const config: PilotInboundConfig = {
  guildId,
  parentId,
  threadId,
  botId,
  playerId,
  token,
  scope: pilotInboundScope,
};

function message(overrides: Record<string, unknown> = {}): Message {
  return {
    partial: false,
    author: { id: playerId, bot: false },
    webhookId: null,
    system: false,
    guildId,
    channelId: threadId,
    id: "1888888888888888888",
    type: MessageType.Default,
    content: "<@" + botId + "> [Sentinel] Report readiness.",
    channel: {
      type: ChannelType.PublicThread,
      isThread: () => true,
      parentId,
      send: vi.fn(),
    },
    mentions: { users: new Map([[botId, { id: botId }]]) },
    reply: vi.fn(),
    ...overrides,
  } as unknown as Message;
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return Object.assign(new EventEmitter(), {
    user: { id: botId },
    guilds: { cache: new Map([[guildId, {}]]) },
    login: vi.fn().mockResolvedValue("connected"),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

describe("Step 14 inbound-only pilot offline guards", () => {
  it("requires the exact private pilot identity and keeps normal bot, outbound and LLM disabled", () => {
    expect(validatePilotInboundEnvironment(environment)).toEqual(config);
    for (const invalid of [
      { LW_PILOT_TEST_USER_ID: "" },
      { LW_PILOT_TEST_USER_ID: botId },
      { LW_DEV_BOT_USER_ID: playerId },
      { LW_PILOT_PARENT_CHANNEL_ID: environment.LW_DEV_PARENT_CHANNEL_ID },
      { LW_PILOT_PARENT_CHANNEL_ID: "1655555555555555555" },
      { LW_PILOT_THREAD_ID: "1655555555555555555" },
      { LW_DEV_GUILD_ID: "1655555555555555555" },
      { DISCORD_TOKEN: "" },
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { NODE_ENV: "production" },
      { DATABASE_URL: environment.DATABASE_URL?.replace("55432", "5432") },
    ]) {
      expect(() =>
        validatePilotInboundEnvironment({ ...environment, ...invalid }),
      ).toThrow();
    }
  });

  it("defaults to nonnetwork preflight, but requires all exact confirmation flags for login", () => {
    expect(parsePilotInboundArguments([])).toBe("preflight");
    expect(parsePilotInboundArguments(["--preflight"])).toBe("preflight");
    const flags = [
      "--connect",
      "--confirm-world",
      "lw-dev-pilot-001",
      "--confirm-context",
      pilotInboundScope.contextId,
      "--confirm-guild",
      guildId,
      "--confirm-database",
      "living_world_gateway_dev",
      "--inbound-only",
      "--one-message",
    ];
    expect(parsePilotInboundArguments(flags)).toBe("connect");
    for (const wrong of [
      flags.slice(0, -1),
      flags.map((part) =>
        part === "lw-dev-pilot-001" ? "lw-dev-gateway-001" : part,
      ),
      flags.map((part) =>
        part === pilotInboundScope.contextId
          ? "3608a56c-2597-4df9-b749-b37b7d7cdacf"
          : part,
      ),
      flags.map((part) => (part === guildId ? "1655555555555555555" : part)),
      flags.map((part) =>
        part === "living_world_gateway_dev" ? "production" : part,
      ),
    ])
      expect(() => parsePilotInboundArguments(wrong)).toThrow();
  });

  it("rejects every other route, sender, message type or content before persistence", () => {
    const good = message();
    expect(pickPilotInboundMessage(good, config)).toMatchObject({
      authorId: playerId,
      guildId,
      channelId: parentId,
      threadId,
      content: "<@" + botId + "> [Sentinel] Report readiness.",
    });
    expect(
      pickPilotInboundMessage(
        message({
          content: "<@!" + botId + "> [Sentinel] Report readiness.",
        }),
        config,
      ),
    ).not.toBeNull();
    for (const invalid of [
      { partial: true },
      { guildId: "1655555555555555555" },
      { channelId: parentId },
      { author: { id: "1999999999999999999", bot: false } },
      { author: { id: playerId, bot: true } },
      { webhookId: "1888888888888888888" },
      { system: true },
      { type: MessageType.Reply },
      {
        channel: {
          type: ChannelType.GuildText,
          isThread: () => false,
          parentId,
        },
      },
      {
        channel: {
          type: ChannelType.PublicThread,
          isThread: () => true,
          parentId: "1666666666666666666",
        },
      },
      { content: "" },
      { content: "Some private campaign message" },
      { content: "<@" + botId + "> [OtherNPC] Report readiness." },
      {
        content:
          "<@" + botId + "> [Sentinel] Report readiness. Additional secret",
      },
      { content: "[Sentinel] Report readiness." },
      { mentions: { users: new Map() } },
    ])
      expect(pickPilotInboundMessage(message(invalid), config)).toBeNull();
  });

  it("accepts exactly one eligible event with an offline fake Client, audits it and never sends", async () => {
    const client = fakeClient();
    const first = message();
    const intake = vi.fn().mockResolvedValue("accepted");
    const verify = vi.fn().mockResolvedValue(undefined);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const running = connectOnePilotMessage(
        config,
        intake,
        verify,
        client as unknown as Client,
        500,
      );
      await Promise.resolve();
      client.emit(Events.ClientReady);
      client.emit(
        Events.MessageCreate,
        message({ author: { id: "1999999999999999999", bot: false } }),
      );
      client.emit(Events.MessageCreate, first);
      client.emit(Events.MessageCreate, first);
      await running;
      expect(intake).toHaveBeenCalledOnce();
      expect(intake.mock.calls[0][1]).toBe(botId);
      expect(verify).toHaveBeenCalledExactlyOnceWith(first.id);
      expect(client.login).toHaveBeenCalledExactlyOnceWith(token);
      expect(client.destroy).toHaveBeenCalledOnce();
      expect(client.listenerCount(Events.MessageCreate)).toBe(0);
      expect(
        (first.channel as unknown as { send: ReturnType<typeof vi.fn> }).send,
      ).not.toHaveBeenCalled();
      expect(first.reply as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(log.mock.calls.map((call) => call[0])).toEqual([
        JSON.stringify({ event: "pilot_gateway_ready" }),
        JSON.stringify({ event: "pilot_gateway_received" }),
        JSON.stringify({ event: "pilot_gateway_audit_pass" }),
        JSON.stringify({ event: "pilot_gateway_stopped" }),
      ]);
      const printed = JSON.stringify(log.mock.calls);
      expect(printed).not.toContain(token);
      expect(printed).not.toContain(playerId);
      expect(printed).not.toContain(first.content);
      expect(printed).not.toContain(first.id);
    } finally {
      log.mockRestore();
    }
  });

  it("stops safely on wrong bot identity, unexpected intake outcome and timeout", async () => {
    const wrongBot = fakeClient({ user: { id: "1666666666666666666" } });
    const wrong = connectOnePilotMessage(
      config,
      vi.fn(),
      vi.fn(),
      wrongBot as unknown as Client,
      500,
    );
    await Promise.resolve();
    wrongBot.emit(Events.ClientReady);
    await expect(wrong).rejects.toThrow("Unexpected bot identity");
    expect(wrongBot.destroy).toHaveBeenCalledOnce();

    const rejectedClient = fakeClient();
    const rejected = connectOnePilotMessage(
      config,
      vi.fn().mockResolvedValue("duplicate"),
      vi.fn(),
      rejectedClient as unknown as Client,
      500,
    );
    await Promise.resolve();
    rejectedClient.emit(Events.ClientReady);
    rejectedClient.emit(Events.MessageCreate, message());
    await expect(rejected).rejects.toThrow("not accepted");
    expect(rejectedClient.destroy).toHaveBeenCalledOnce();

    const quietClient = fakeClient();
    const quiet = connectOnePilotMessage(
      config,
      vi.fn(),
      vi.fn(),
      quietClient as unknown as Client,
      10,
    );
    await expect(quiet).rejects.toThrow("expired");
    expect(quietClient.destroy).toHaveBeenCalledOnce();
  });
});
