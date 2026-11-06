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
  isFreshNpcE2eSource,
  npcE2eInboundRoute,
  npcE2eInboundTarget,
  parseNpcE2eInboundArguments,
  runNpcE2eInboundCommand,
  validateNpcE2eInboundEnvironment,
  verifyNpcE2eInboundDatabase,
} from "./discord-npc-e2e-inbound.js";
import {
  connectOnePilotMessage,
  pickPilotInboundMessage,
} from "./discord-pilot-gateway.js";

const guildId = "1566911648701223053";
const parentId = "1568349822505717830";
const threadId = "1568350458026786886";
const botId = "1566909036899868712";
const humanId = "1766911648701223053";
const dbSecret = "b".repeat(64);
const token = "offline-only-do-not-use-discord-token";
const environment: NodeJS.ProcessEnv = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: "a".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD: dbSecret,
  DATABASE_URL:
    "postgresql://lw_gateway_dev:" +
    dbSecret +
    "@127.0.0.1:55432/living_world_gateway_dev",
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
  LW_DEV_GUILD_ID: guildId,
  LW_DEV_PARENT_CHANNEL_ID: "1566913668795469934",
  LW_DEV_THREAD_ID: "1566914038158459090",
  LW_PILOT_PARENT_CHANNEL_ID: "1567604837309350030",
  LW_PILOT_THREAD_ID: "1567605016603271208",
  LW_NPC_E2E_PARENT_CHANNEL_ID: parentId,
  LW_NPC_E2E_THREAD_ID: threadId,
  LW_NPC_E2E_TEST_USER_ID: humanId,
  LW_DEV_BOT_USER_ID: botId,
  DISCORD_TOKEN: token,
};

const flags = [
  "--connect",
  "--confirm-world",
  "lw-dev-npc-e2e-001",
  "--confirm-world-id",
  npcE2eInboundTarget.worldId,
  "--confirm-context",
  npcE2eInboundTarget.contextId,
  "--confirm-guild",
  guildId,
  "--confirm-parent",
  parentId,
  "--confirm-thread",
  threadId,
  "--confirm-database",
  "living_world_gateway_dev",
  "--inbound-only",
  "--one-message",
];

function message(overrides: Record<string, unknown> = {}): Message {
  return {
    partial: false,
    author: { id: humanId, bot: false },
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
    login: vi.fn().mockResolvedValue("offline-fake-connected"),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

describe("M2.14C first Sentinel inbound-only Gateway safeguards", () => {
  it("restricts the target, private identity, local DB and disabled transports", () => {
    const config = validateNpcE2eInboundEnvironment(environment);
    expect(config).toMatchObject({
      botId,
      token,
      guildId,
      parentId,
      threadId,
      playerId: humanId,
      presenceId: npcE2eInboundTarget.presenceId,
      scope: {
        worldKey: "lw-dev-npc-e2e-001",
        worldId: npcE2eInboundTarget.worldId,
        contextId: npcE2eInboundTarget.contextId,
        npcId: npcE2eInboundTarget.npcId,
        playerMappingId: npcE2eInboundTarget.playerMappingId,
        policyAuditId: npcE2eInboundTarget.policyAuditId,
      },
    });
    expect(npcE2eInboundRoute).toEqual({ guildId, parentId, threadId });
    for (const invalid of [
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { NODE_ENV: "production" },
      { DISCORD_TOKEN: "" },
      { LW_DEV_BOT_USER_ID: humanId },
      { LW_NPC_E2E_TEST_USER_ID: botId },
      { LW_NPC_E2E_TEST_USER_ID: "invalid" },
      { LW_NPC_E2E_TEST_USER_ID: undefined },
      { LW_NPC_E2E_PARENT_CHANNEL_ID: environment.LW_PILOT_PARENT_CHANNEL_ID },
      { LW_NPC_E2E_THREAD_ID: environment.LW_PILOT_THREAD_ID },
      { LW_DEV_GUILD_ID: "1666666666666666666" },
      { LW_NPC_E2E_GUILD_ID: "1666666666666666666" },
      { DATABASE_URL: environment.DATABASE_URL?.replace("55432", "5432") },
      {
        DATABASE_URL: environment.DATABASE_URL?.replace(
          "127.0.0.1",
          "example.com",
        ),
      },
    ])
      expect(() =>
        validateNpcE2eInboundEnvironment({ ...environment, ...invalid }),
      ).toThrow();
  });

  it("defaults to read-only preflight and requires every exact live confirmation", () => {
    expect(parseNpcE2eInboundArguments([])).toBe("preflight");
    expect(parseNpcE2eInboundArguments(["--preflight"])).toBe("preflight");
    expect(parseNpcE2eInboundArguments(flags)).toBe("connect");
    for (const bad of [
      ["--connect"],
      ["--send"],
      ["--apply"],
      ["--preflight", "--connect"],
      flags.slice(0, -1),
      flags.map((x) => (x === "lw-dev-npc-e2e-001" ? "lw-dev-pilot-001" : x)),
      flags.map((x) =>
        x === npcE2eInboundTarget.worldId
          ? "585b48b9-9160-4366-9312-455c39551302"
          : x,
      ),
      flags.map((x) => (x === parentId ? "1567604837309350030" : x)),
      flags.map((x) => (x === threadId ? "1567605016603271208" : x)),
      flags.map((x) =>
        x === "living_world_gateway_dev" ? "living_world_prod" : x,
      ),
    ])
      expect(() => parseNpcE2eInboundArguments(bad)).toThrow();
  });

  it("accepts only a new source event, not a replay or future-dated snowflake", () => {
    const snowflake = (ms: number) =>
      ((BigInt(ms) - 1420070400000n) << 22n).toString();
    const armed = 1793990000000;
    expect(
      isFreshNpcE2eSource(snowflake(armed + 1000), armed, armed + 1200),
    ).toBe(true);
    expect(isFreshNpcE2eSource(snowflake(armed - 1), armed, armed + 2000)).toBe(
      false,
    );
    expect(isFreshNpcE2eSource(snowflake(armed + 31000), armed, armed)).toBe(
      false,
    );
    expect(isFreshNpcE2eSource("not-a-message-id", armed, armed)).toBe(false);
  });

  it("restricts exactly one owner message to the new public thread with literal bot alias", () => {
    const config = validateNpcE2eInboundEnvironment(environment);
    expect(pickPilotInboundMessage(message(), config)).toMatchObject({
      authorId: humanId,
      guildId,
      channelId: parentId,
      threadId,
    });
    for (const invalid of [
      { partial: true },
      { guildId: "1666666666666666666" },
      { channelId: parentId },
      { author: { id: botId, bot: true } },
      { author: { id: "1999999999999999999", bot: false } },
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
          type: ChannelType.PrivateThread,
          isThread: () => true,
          parentId,
        },
      },
      { content: "<@" + botId + "> [Another] Report readiness." },
      { content: "<@" + botId + "> [Sentinel] Report readiness. more text" },
      { content: "Private roleplay text" },
      { mentions: { users: new Map() } },
    ])
      expect(pickPilotInboundMessage(message(invalid), config)).toBeNull();
  });

  it("reuses proven one-event transport with an offline fake client and no sends", async () => {
    const config = validateNpcE2eInboundEnvironment(environment);
    const client = fakeClient();
    const valid = message();
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
      client.emit(Events.MessageCreate, message({ channelId: parentId }));
      client.emit(Events.MessageCreate, valid);
      client.emit(Events.MessageCreate, valid);
      await running;
      expect(intake).toHaveBeenCalledOnce();
      expect(verify).toHaveBeenCalledOnce();
      expect(client.login).toHaveBeenCalledExactlyOnceWith(token);
      expect(client.destroy).toHaveBeenCalledOnce();
      expect(client.listenerCount(Events.MessageCreate)).toBe(0);
      expect(
        (valid.channel as unknown as { send: ReturnType<typeof vi.fn> }).send,
      ).not.toHaveBeenCalled();
      expect(valid.reply as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain(token);
      expect(JSON.stringify(log.mock.calls)).not.toContain(humanId);
      expect(JSON.stringify(log.mock.calls)).not.toContain(valid.content);
    } finally {
      log.mockRestore();
    }
  });

  it("rejects a privileged database before any verifier lookup", async () => {
    const config = validateNpcE2eInboundEnvironment(environment);
    const statements: unknown[] = [];
    const execute = vi.fn().mockImplementation(async (statement: unknown) => {
      statements.push(statement);
      return {
        rows:
          statements.length < 3
            ? []
            : [
                {
                  database: "living_world_gateway_dev",
                  role: "postgres",
                  version: 170011,
                  superuser: true,
                  createdb: true,
                  createrole: true,
                },
              ],
      };
    });
    const db = {
      transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }),
    };
    await expect(
      verifyNpcE2eInboundDatabase(
        db as unknown as Parameters<typeof verifyNpcE2eInboundDatabase>[0],
        config,
        "before",
      ),
    ).rejects.toThrow("identity is not approved");
    expect(statements).toHaveLength(3);
  });

  it("rejects unsafe environment before opening a database or a Gateway", async () => {
    const connect = vi.fn();
    await expect(
      runNpcE2eInboundCommand(
        flags,
        { ...environment, DISCORD_OUTBOUND_ENABLED: "true" },
        connect as unknown as Parameters<typeof runNpcE2eInboundCommand>[2],
      ),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});
