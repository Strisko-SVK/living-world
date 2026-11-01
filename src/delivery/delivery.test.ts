import { describe, expect, it, vi } from "vitest";
import {
  fingerprint,
  identitySchema,
  payloadSchema,
  retryDelay,
  type DeliveryPayload,
} from "./contracts.js";
import { resolveOriginalRoute, type RouteCandidate } from "./routing.js";
import { fakeDeliveryTransport } from "./delivery.test-fixture.js";
const scope = {
  worldId: "00000000-0000-4000-8000-000000000001",
  npcId: "00000000-0000-4000-8000-000000000002",
  interactionId: "00000000-0000-4000-8000-000000000003",
};
const payload: DeliveryPayload = {
  scope,
  destination: {
    provider: "discord",
    guildId: "guild",
    channelId: "channel",
    threadId: "thread",
  },
  replyToMessageId: "123",
  identity: { displayName: "Pelo", avatarUrl: null },
  content: "@everyone @here <@123> <@&456> **untrusted markdown**",
  allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
};
const original = {
  guildId: "guild",
  channelId: "channel",
  threadId: "thread",
  mappingId: "exact",
};
const route: RouteCandidate = {
  ...original,
  id: "exact",
  contextId: "scene",
  worldId: scope.worldId,
  status: "active",
  mappingType: "scene",
  worldActive: true,
};
describe("delivery payload and identity boundary", () => {
  it("preserves speech while explicitly disabling every mention category and reply ping", () => {
    expect(payloadSchema.parse(payload)).toEqual(payload);
    expect(payload.allowedMentions).toEqual({
      parse: [],
      users: [],
      roles: [],
      repliedUser: false,
    });
  });
  it.each(["", " ", "a".repeat(2001), "😀".repeat(1001)])(
    "rejects unsupported single-message content %#",
    (content) =>
      expect(payloadSchema.safeParse({ ...payload, content }).success).toBe(
        false,
      ),
  );
  it("accepts exactly 2000 UTF-16 units without truncation", () =>
    expect(
      payloadSchema.parse({ ...payload, content: "a".repeat(2000) }).content
        .length,
    ).toBe(2000));
  it.each([
    "",
    " ",
    " @everyone",
    "<@123>",
    "a".repeat(81),
    "Pelo\n",
    "Pelo\u200b",
    "Clyde",
    "DISCORD",
  ])("rejects unsafe identity %#", (displayName) =>
    expect(
      identitySchema.safeParse({ displayName, avatarUrl: null }).success,
    ).toBe(false),
  );
  it.each([
    "http://cdn.discordapp.com/avatars/123/abc.png",
    "https://localhost/a.png",
    "https://evil.test/a.png",
    "https://discord.com/api/webhooks/123/secret",
    "https://cdn.discordapp.com/avatars/123/abc.png?token=secret",
    "https://user:password@cdn.discordapp.com/avatars/123/abc.png",
    "https://cdn.discordapp.com:444/avatars/123/abc.png",
  ])("rejects unsafe avatar %#", (avatarUrl) =>
    expect(
      identitySchema.safeParse({ displayName: "Pelo", avatarUrl }).success,
    ).toBe(false),
  );
  it("accepts only an approved static Discord CDN avatar shape", () =>
    expect(
      identitySchema.safeParse({
        displayName: "Pelo",
        avatarUrl: "https://cdn.discordapp.com/avatars/123/abc123.png",
      }).success,
    ).toBe(true));
  it("rejects attempts to enable mentions", () =>
    expect(
      payloadSchema.safeParse({
        ...payload,
        allowedMentions: {
          parse: ["everyone"],
          users: [],
          roles: [],
          repliedUser: false,
        },
      }).success,
    ).toBe(false));
  it("fingerprints canonical parsed payloads independently of object key order", () => {
    expect(fingerprint(payload)).toBe(
      fingerprint({
        ...payload,
        identity: { avatarUrl: null, displayName: "Pelo" },
      }),
    );
    expect(fingerprint({ ...payload, content: "Different" })).not.toBe(
      fingerprint(payload),
    );
  });
  it("bounds retries and honors a longer no-send retry-after", () => {
    expect([1, 2, 3].map((n) => retryDelay(n, 0))).toEqual([1000, 2000, 4000]);
    expect(retryDelay(1, 5000)).toBe(5000);
  });
});
describe("original scene routing", () => {
  it("uses exact thread rather than primary/fallback scene", () =>
    expect(
      resolveOriginalRoute(scope, "scene", original, [
        route,
        { ...route, id: "fallback", threadId: null, contextId: "primary" },
      ]),
    ).toBe(true));
  it.each(
    [
      [],
      [{ ...route, status: "inactive" }],
      [{ ...route, worldActive: false }],
      [{ ...route, contextId: "other" }],
      [{ ...route, id: "replacement" }],
      [{ ...route, mappingType: "npc_primary" }],
      [{ ...route, threadId: "other" }],
      [{ ...route, guildId: "foreign" }],
      [{ ...route, worldId: "foreign" }],
      [route, { ...route, id: "ambiguous", worldId: "foreign" }],
      [route, { ...route, id: "duplicate" }],
    ].map((rows) => [rows] as [RouteCandidate[]]),
  )("fails closed for unavailable or ambiguous original route %#", (rows) =>
    expect(resolveOriginalRoute(scope, "scene", original, rows)).toBe(false),
  );
  it("retains original thread when the original authorization used parent fallback", () =>
    expect(
      resolveOriginalRoute(
        scope,
        "scene",
        { ...original, mappingId: "fallback" },
        [{ ...route, id: "fallback", threadId: null }],
      ),
    ).toBe(true));
  it("does not silently replace parent fallback after a new exact mapping appears", () =>
    expect(
      resolveOriginalRoute(
        scope,
        "scene",
        { ...original, mappingId: "fallback" },
        [{ ...route, id: "fallback", threadId: null }, route],
      ),
    ).toBe(false));
});
describe("isolated fake transport", () => {
  it("refuses unallowlisted worlds", async () => {
    const fake = fakeDeliveryTransport(new Set());
    await expect(
      fake.send({
        payload,
        attemptId: scope.npcId,
        fingerprint: fingerprint(payload),
      }),
    ).rejects.toThrow("Isolated");
    expect(fake.sent).toEqual([]);
  });
  it("refuses non-test invocation", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const fake = fakeDeliveryTransport(new Set([scope.worldId]));
      await expect(
        fake.send({
          payload,
          attemptId: scope.npcId,
          fingerprint: fingerprint(payload),
        }),
      ).rejects.toThrow("Isolated");
      expect(fake.sent).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
