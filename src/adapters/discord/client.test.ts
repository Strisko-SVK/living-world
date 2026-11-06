import { discordMessageCreatedAt } from "../../intake/discord-snowflake.js";
import { EventEmitter } from "node:events";
import { ChannelType, Events, MessageType, type Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createDiscordAdapter } from "./client.js";
import { normalizeDiscordMessage } from "./message.js";

function event(overrides: Record<string, unknown> = {}): Message {
  return {
    id: "00123",
    author: { id: "author", bot: false },
    partial: false,
    webhookId: null,
    system: false,
    guildId: "guild",
    channelId: "channel",
    type: MessageType.Default,
    content: "<@123> Check the manifest.",
    channel: {
      type: ChannelType.GuildText,
      isThread: () => false,
      send: vi.fn(),
    },
    mentions: {
      users: new Map([
        ["123", {}],
        ["456", {}],
      ]),
    },
    reply: vi.fn(),
    fetch: vi.fn(),
    createdTimestamp: 999999,
    attachments: new Map([["attachment", { url: "private" }]]),
    ...overrides,
  } as unknown as Message;
}
const config = {
  enabled: true,
  token: "test-token",
  intents: ["Guilds", "GuildMessages", "MessageContent"] as [
    "Guilds",
    "GuildMessages",
    "MessageContent",
  ],
};
function setup(intake = vi.fn().mockResolvedValue(undefined)) {
  const client = Object.assign(new EventEmitter(), {
    user: { id: "123" },
    login: vi.fn().mockResolvedValue("test-token"),
    destroy: vi.fn().mockResolvedValue(undefined),
  });
  const diagnostics = vi.fn();
  const adapter = createDiscordAdapter(
    config,
    intake,
    diagnostics,
    client as unknown as Parameters<typeof createDiscordAdapter>[3],
  );
  return { client, intake, diagnostics, adapter };
}

describe("Discord transport normalization", () => {
  it.each([
    {
      label: "empty content",
      overrides: { content: "" },
      reason: "content_unavailable",
    },
    {
      label: "whitespace-only content",
      overrides: { content: "  " },
      reason: "content_unavailable",
    },
    {
      label: "missing content",
      overrides: { content: undefined },
      reason: "content_unavailable",
    },
    {
      label: "wrong content type",
      overrides: { content: 42 },
      reason: "content_unavailable",
    },
    {
      label: "missing thread parent",
      overrides: {
        channel: {
          type: ChannelType.PublicThread,
          parentId: null,
          isThread: () => true,
        },
      },
      reason: "thread_parent_missing",
    },
    {
      label: "malformed mention collection",
      overrides: { mentions: null },
      reason: "mentions_unavailable",
    },
    {
      label: "invalid event ID",
      overrides: { id: "bad id" },
      reason: "source_message_id_invalid",
    },
    {
      label: "oversized content",
      overrides: { content: "x".repeat(20001) },
      reason: "content_invalid",
    },
    {
      label: "unsupported message kind",
      overrides: { type: MessageType.ChannelPinnedMessage },
      reason: "message_shape_rejected",
    },
  ])(
    "reports only sanitized rejection reason for $label",
    ({ overrides, reason }) => {
      const diagnose = vi.fn();
      expect(normalizeDiscordMessage(event(overrides), diagnose)).toBeNull();
      expect(diagnose).toHaveBeenCalledExactlyOnceWith(reason);
      const log = JSON.stringify(diagnose.mock.calls);
      expect(log).not.toContain("bad id");
      expect(log).not.toContain("x".repeat(20));
      expect(log).not.toContain("Check the manifest.");
    },
  );
  it("extracts minimal input without SDK objects, attachments, reply metadata or timestamps", () => {
    expect(normalizeDiscordMessage(event())).toEqual({
      sourceMessageId: "00123",
      authorId: "author",
      guildId: "guild",
      channelId: "channel",
      threadId: null,
      content: "<@123> Check the manifest.",
      mentionedUserIds: ["123"],
    });
  });
  it("binds source time to the SDK message ID despite timestamp and content assertions", () => {
    const message = normalizeDiscordMessage(
      event({
        id: "175928847299117063",
        sourceMessageId: "999999999999999999",
        createdTimestamp: Date.now(),
        timestamp: "2099-01-01T00:00:00Z",
        content: '<@123> {"createdAt":"2099-01-01T00:00:00Z"}',
      }),
    )!;
    expect(message.sourceMessageId).toBe("175928847299117063");
    expect(discordMessageCreatedAt(message.sourceMessageId)).toBe(
      1462015105796,
    );
    expect(message).not.toHaveProperty("createdTimestamp");
    expect(message).not.toHaveProperty("timestamp");
  });
  it("normalizes thread parent and exact thread separately", () => {
    expect(
      normalizeDiscordMessage(
        event({
          channelId: "thread",
          channel: {
            type: ChannelType.PublicThread,
            parentId: "parent",
            isThread: () => true,
          },
        }),
      ),
    ).toMatchObject({ channelId: "parent", threadId: "thread" });
  });
  it.each([
    { author: { id: "author", bot: true } },
    { partial: true },
    { guildId: null },
    { webhookId: "webhook" },
    { system: true },
    { type: MessageType.ChannelPinnedMessage },
    { channel: { type: ChannelType.GuildVoice } },
    { content: "" },
    {
      channel: {
        type: ChannelType.PrivateThread,
        parentId: null,
        isThread: () => true,
      },
    },
  ])("ignores unsupported event %j", (overrides) => {
    expect(normalizeDiscordMessage(event(overrides))).toBeNull();
  });
  it("supports replies without making the replied-to author a target", () => {
    expect(
      normalizeDiscordMessage(
        event({
          type: MessageType.Reply,
          content: "A reply without a literal mention",
        }),
      ),
    ).toMatchObject({ mentionedUserIds: [] });
  });
});

describe("Discord client lifecycle", () => {
  it("does not log in at construction; starts, reports ready, and stops without outbound sends", async () => {
    const { adapter, client, intake, diagnostics } = setup();
    expect(client.login).not.toHaveBeenCalled();
    await adapter.start();
    client.emit(Events.ClientReady);
    const message = event();
    client.emit(Events.MessageCreate, message);
    await adapter.stop();
    expect(intake).toHaveBeenCalledWith(
      normalizeDiscordMessage(message),
      "123",
    );
    expect(client.login).toHaveBeenCalledWith("test-token");
    expect(diagnostics).toHaveBeenCalledWith({ event: "discord_ready" });
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.fetch).not.toHaveBeenCalled();
    expect(
      "send" in message.channel && message.channel.send,
    ).not.toHaveBeenCalled();
    expect(client.listenerCount(Events.MessageCreate)).toBe(0);
    await adapter.stop();
    expect(client.destroy).toHaveBeenCalledOnce();
  });
  it("ignores events until an authenticated client identity exists", async () => {
    const f = setup();
    Object.assign(f.client, { user: null });
    await f.adapter.start();
    f.client.emit(Events.MessageCreate, event());
    await f.adapter.stop();
    expect(f.intake).not.toHaveBeenCalled();
  });
  it("ignores unsupported transport messages before intake", async () => {
    const { adapter, client, intake } = setup();
    await adapter.start();
    client.emit(
      Events.MessageCreate,
      event({ author: { id: "bot", bot: true } }),
    );
    await adapter.stop();
    expect(intake).not.toHaveBeenCalled();
  });
  it("drains in-flight persistence and rejects events after shutdown begins", async () => {
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter, client, intake } = setup(
      vi.fn().mockReturnValue(deferred),
    );
    await adapter.start();
    client.emit(Events.MessageCreate, event());
    let stopped = false;
    const stop = adapter.stop().then(() => {
      stopped = true;
    });
    client.emit(Events.MessageCreate, event());
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(intake).toHaveBeenCalledOnce();
    release();
    await stop;
    expect(stopped).toBe(true);
  });
  it("sanitizes startup failure and releases transport resources", async () => {
    const { adapter, client, diagnostics } = setup();
    client.login.mockRejectedValue(new Error("secret-token"));
    await expect(adapter.start()).rejects.toThrow("Discord startup failed.");
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(
      "secret-token",
    );
    expect(client.listenerCount(Events.MessageCreate)).toBe(0);
  });
  it("isolates malformed transport and rejected intake errors", async () => {
    const { adapter, client, diagnostics } = setup(
      vi.fn().mockRejectedValue(new Error("private content")),
    );
    await adapter.start();
    client.emit(Events.MessageCreate, {});
    client.emit(Events.MessageCreate, event());
    await adapter.stop();
    expect(diagnostics).toHaveBeenCalledWith({
      event: "discord_message_error",
    });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(
      "private content",
    );
  });
  it("handles connection errors, disconnect and resume without event dumps", async () => {
    const { adapter, client, diagnostics } = setup();
    await adapter.start();
    client.emit(Events.Error, new Error("secret-token"));
    client.emit(Events.ShardError, new Error("private content"));
    client.emit(Events.ShardDisconnect, { reason: "private reason" });
    client.emit(Events.ShardResume);
    await adapter.stop();
    expect(diagnostics).toHaveBeenCalledWith({
      event: "discord_connection_error",
    });
    expect(diagnostics).toHaveBeenCalledWith({ event: "discord_disconnected" });
    expect(diagnostics).toHaveBeenCalledWith({ event: "discord_resumed" });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(
      "secret-token",
    );
  });
  it("prevents restart after shutdown", async () => {
    const { adapter } = setup();
    await adapter.stop();
    await expect(adapter.start()).rejects.toThrow("cannot be started again");
  });
});
