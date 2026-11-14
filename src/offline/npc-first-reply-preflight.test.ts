import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineSpeechReadinessRequest } from "../communication/scene-speech-readiness.js";
import {
  createOfflineFirstReplyPreflight,
  firstReplyText,
  type FirstReplyFacts,
  type FirstReplyRequest,
} from "./npc-first-reply-preflight.js";

const request: FirstReplyRequest = {
  worldId: "11111111-1111-4111-8111-111111111111",
  npcId: "22222222-2222-4222-8222-222222222222",
  contextId: "33333333-3333-4333-8333-333333333333",
  interactionId: "44444444-4444-4444-8444-444444444444",
  playerEntityId: "55555555-5555-4555-8555-555555555555",
  guildId: "1566911648701223053",
  parentId: "1568349822505717830",
  threadId: "1568350458026786886",
  sourceMessageId: String(
    (1_800_000_000_000n - 1_420_070_400_000n) << 22n,
  ),
};
const presenceId = "66666666-6666-4666-8666-666666666666";
const issuedAt = new Date(1_800_000_000_000 - 60_000);
const eventMs = 1_800_000_000_000;

function speech(): OfflineSpeechReadinessRequest {
  return {
    worldId: request.worldId,
    npcId: request.npcId,
    contextId: request.contextId,
    interactionId: request.interactionId,
    sourceMessageId: request.sourceMessageId,
    presenceId,
    npcStateVersion: 3,
    nowMs: eventMs + 1000,
    contact: {
      path: "direct_in_scene",
      status: "needs_review",
      reason: "activity_unknown",
      canGrantPresence: false,
      canGenerate: false,
      canSend: false,
    },
    approval: {
      id: "77777777-7777-4777-8777-777777777777",
      worldId: request.worldId,
      npcId: request.npcId,
      contextId: request.contextId,
      presenceId,
      npcStateVersion: 3,
      issuedByEntityId: "88888888-8888-4888-8888-888888888888",
      issuedByRole: "host_operator",
      decision: "allow_direct_speech",
      activity: "free",
      perception: "aware",
      otherScene: "none",
      issuedAt,
      expiresAt: new Date(eventMs + 60_000),
      revokedAt: null,
    },
  };
}

function evidence(): FirstReplyFacts {
  return {
    speech: speech(),
    source: {
      worldId: request.worldId,
      npcId: request.npcId,
      contextId: request.contextId,
      interactionId: request.interactionId,
      speakerEntityId: request.playerEntityId,
      sourceProvider: "discord",
      sourceMessageId: request.sourceMessageId,
      sourceGuildId: request.guildId,
      sourceChannelId: request.parentId,
      sourceThreadId: request.threadId,
      sourceMappingId: "99999999-9999-4999-8999-999999999999",
      status: "received",
      communicationMode: "unknown",
      localPresenceId: null,
      responseText: null,
      responseClaimId: null,
    },
    deliveryCount: 0,
  };
}

function fixture(value: FirstReplyFacts | null = evidence()) {
  const read = vi.fn(async () => value);
  return { read, preview: createOfflineFirstReplyPreflight(read) };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DISCORD_ENABLED", "false");
  vi.stubEnv("DISCORD_OUTBOUND_ENABLED", "false");
  vi.stubEnv("LLM_PROVIDER", "disabled");
});
afterEach(() => vi.unstubAllEnvs());

describe("M2.15J offline first-reply operator preflight", () => {
  it("reports a strictly bound fixed-text fake-only candidate with no action permission", async () => {
    const f = fixture();
    expect(await f.preview(request)).toEqual({
      event: "npc_first_reply_preflight",
      status: "fake_only_candidate",
      reason: "fake_only_eligible",
      readOnly: true,
      wouldSend: false,
      canGenerate: false,
      canSend: false,
      canRehearseFake: true,
      fixedReply: firstReplyText,
    });
    expect(f.read).toHaveBeenCalledExactlyOnceWith({
      worldId: request.worldId,
      npcId: request.npcId,
      contextId: request.contextId,
      interactionId: request.interactionId,
    });
  });

  it.each([
    ["world", { worldId: request.npcId }],
    ["npc", { npcId: request.worldId }],
    ["scene", { contextId: request.npcId }],
    ["interaction", { interactionId: request.contextId }],
    ["player", { playerEntityId: request.npcId }],
    ["source event", { sourceMessageId: "1566911648701223066" }],
    ["guild", { guildId: request.threadId }],
    ["parent", { parentId: request.threadId }],
    ["thread", { threadId: request.parentId }],
  ])("rejects a substituted %s and cannot grant a real send", async (_, patch) => {
    const f = fixture();
    expect(await f.preview({ ...request, ...patch })).toMatchObject({
      status: "blocked",
      reason: "source_mismatch",
      canSend: false,
      wouldSend: false,
    });
  });

  it.each([
    { ...request, dm: true },
    { ...request, ownerApproved: true },
    { ...request, execute: true },
    { ...request, sourceMessageId: "not-a-snowflake" },
    { ...request, threadId: null },
  ])("rejects forged permissions or malformed request before reading anything", async (input) => {
    const f = fixture();
    expect(await f.preview(input)).toMatchObject({
      status: "blocked",
      reason: "invalid_request",
    });
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null, "unverified"],
    ["existing outbox", { ...evidence(), deliveryCount: 1 }, "delivery_exists"],
    ["negative outbox count", { ...evidence(), deliveryCount: -1 }, "delivery_exists"],
    ["response already started", {
      ...evidence(),
      source: { ...evidence().source, status: "processing" as const },
    }, "unverified"],
    ["presence already assigned", {
      ...evidence(),
      source: { ...evidence().source, localPresenceId: presenceId as null },
    }, "unverified"],
  ] as const)(
    "blocks %s evidence",
    async (_label, value, reason) => {
      const f = fixture(value as FirstReplyFacts | null);
      expect(await f.preview(request)).toMatchObject({
        status: "blocked",
        reason,
        canRehearseFake: false,
      });
    },
  );

  it.each([
    ["missing host approval", { approval: null }],
    ["revoked approval", {
      approval: { ...speech().approval!, revokedAt: new Date(eventMs) },
    }],
    ["inferred DM identity", {
      approval: { ...speech().approval!, issuedByRole: "world_dm" as const },
    }],
    ["busy NPC", {
      approval: { ...speech().approval!, activity: "busy" as const },
    }],
    ["cross-scene conflict", {
      approval: { ...speech().approval!, otherScene: "active" as const },
    }],
    ["expired policy", { nowMs: eventMs + 61_000 }],
    ["event predates consent", {
      approval: {
        ...speech().approval!,
        issuedAt: new Date(eventMs + 1),
      },
    }],
  ] as const)("blocks %s without a side effect", async (_label, patch) => {
    const base = evidence();
    const f = fixture({ ...base, speech: { ...base.speech, ...patch } });
    expect(await f.preview(request)).toMatchObject({
      status: "blocked",
      reason: "host_policy_denied",
      canSend: false,
      wouldSend: false,
    });
  });

  it("refuses a forged speech snapshot with a different stored event", async () => {
    const base = evidence();
    const f = fixture({
      ...base,
      speech: { ...base.speech, sourceMessageId: "1566911648701223066" },
    });
    expect(await f.preview(request)).toMatchObject({
      status: "blocked",
      reason: "source_mismatch",
    });
  });

  it.each([
    ["NODE_ENV", "production"],
    ["DISCORD_ENABLED", "true"],
    ["DISCORD_OUTBOUND_ENABLED", "true"],
    ["LLM_PROVIDER", "openai"],
  ] as const)("never reads facts when %s is %s", async (key, value) => {
    const f = fixture();
    vi.stubEnv(key, value);
    expect(await f.preview(request)).toMatchObject({
      status: "blocked",
      reason: "offline_only",
      readOnly: true,
      canSend: false,
    });
    expect(f.read).not.toHaveBeenCalled();
  });

  it("does not expose a private repository failure or authorize a send", async () => {
    const read = vi.fn().mockRejectedValue(new Error("private SQL and user content"));
    const preview = createOfflineFirstReplyPreflight(read);
    const result = await preview(request);
    expect(result).toMatchObject({
      status: "blocked",
      reason: "unverified",
      canSend: false,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
