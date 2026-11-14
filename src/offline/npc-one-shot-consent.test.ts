import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOfflineOneShotPilot,
  type OfflinePilotConsent,
  type OfflinePilotDependencies,
  type OfflinePilotTarget,
} from "./npc-one-shot-consent.js";
import {
  firstReplyText,
  type FirstReplyPreview,
} from "./npc-first-reply-preflight.js";

const eventMs = 1_800_000_000_000;
const eventId = String((BigInt(eventMs) - 1_420_070_400_000n) << 22n);
const target: OfflinePilotTarget = {
  worldId: "11111111-1111-4111-8111-111111111111",
  npcId: "22222222-2222-4222-8222-222222222222",
  contextId: "33333333-3333-4333-8333-333333333333",
  interactionId: "44444444-4444-4444-8444-444444444444",
  playerEntityId: "55555555-5555-4555-8555-555555555555",
  sourceMessageId: eventId,
  guildId: "1566911648701223053",
  parentId: "1568349822505717830",
  threadId: "1568350458026786886",
};

function preview(): FirstReplyPreview {
  return {
    event: "npc_first_reply_preflight",
    status: "fake_only_candidate",
    reason: "fake_only_eligible",
    readOnly: true,
    canRehearseFake: true,
    canGenerate: false,
    canSend: false,
    wouldSend: false,
    fixedReply: firstReplyText,
  };
}

function consent(): OfflinePilotConsent {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    issuedByOperatorId: "77777777-7777-4777-8777-777777777777",
    issuerRole: "host_operator",
    target: { ...target },
    fixedReply: firstReplyText,
    issuedAt: new Date(eventMs - 30_000),
    expiresAt: new Date(eventMs + 60_000),
    revokedAt: null,
  };
}

function fixture() {
  let current: unknown = consent();
  let currentPreview = preview();
  const consumed = new Set<string>();
  const preflight = vi.fn(async () => currentPreview);
  const readTrustedConsent = vi.fn(async () => current);
  const claimOnce = vi.fn(async (_id: string, requested: OfflinePilotTarget) => {
    // The real database must uniquely bind a send to its original event.
    // Reissuing a fresh consent ID must never reset this latch.
    const key = [
      requested.worldId,
      requested.interactionId,
      requested.sourceMessageId,
    ].join(":");
    if (consumed.has(key)) return false;
    consumed.add(key);
    return true;
  });
  const fakeSend = vi.fn(async () => "ack" as const);
  const deps: OfflinePilotDependencies = {
    preflight,
    readTrustedConsent,
    claimOnce,
    fakeSend,
    clock: () => new Date(eventMs + 1000),
  };
  return {
    run: createOfflineOneShotPilot(deps),
    preflight,
    readTrustedConsent,
    claimOnce,
    fakeSend,
    consumed,
    setConsent(value: unknown) {
      current = value;
    },
    setPreview(value: FirstReplyPreview) {
      currentPreview = value;
    },
  };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DISCORD_ENABLED", "false");
  vi.stubEnv("DISCORD_OUTBOUND_ENABLED", "false");
  vi.stubEnv("LLM_PROVIDER", "disabled");
});
afterEach(() => vi.unstubAllEnvs());

describe("M2.15K disposable one-shot owner consent contract", () => {
  it("performs one fixed-text fake attempt and blocks replay", async () => {
    const f = fixture();
    expect(await f.run(target)).toEqual({
      event: "npc_offline_one_shot_pilot",
      outcome: "fake_ack",
      readOnly: true,
      canGenerate: false,
      canSend: false,
      wouldSend: false,
    });
    expect(f.fakeSend).toHaveBeenCalledExactlyOnceWith({
      target,
      text: firstReplyText,
    });
    expect(f.claimOnce).toHaveBeenCalledExactlyOnceWith(consent().id, target);
    expect(f.preflight).toHaveBeenCalledTimes(2);
    expect(f.readTrustedConsent).toHaveBeenCalledTimes(2);
    expect(await f.run(target)).toMatchObject({
      outcome: "already_consumed",
      canSend: false,
    });
    expect(f.fakeSend).toHaveBeenCalledTimes(1);
  });

  it("allows only one fake attempt under simultaneous requests", async () => {
    const f = fixture();
    const outcomes = (await Promise.all([f.run(target), f.run(target)])).map(
      (r) => r.outcome,
    );
    expect(outcomes.sort()).toEqual(["already_consumed", "fake_ack"]);
    expect(f.claimOnce).toHaveBeenCalledTimes(2);
    expect(f.fakeSend).toHaveBeenCalledTimes(1);
  });

  it("cannot rearm an already-used event by replacing consent ID", async () => {
    const f = fixture();
    expect(await f.run(target)).toMatchObject({ outcome: "fake_ack" });
    f.setConsent({
      ...consent(),
      id: "88888888-8888-4888-8888-888888888888",
    });
    expect(await f.run(target)).toMatchObject({
      outcome: "already_consumed",
      canSend: false,
    });
    expect(f.fakeSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...target, isDm: true },
    { ...target, ownerApproved: true },
    { ...target, execute: true },
    { ...target, botToken: "secret" },
    { ...target, sourceMessageId: "not-snowflake" },
    { ...target, contextId: "wrong" },
    { ...target, threadId: null },
  ])(
    "rejects malformed or forged input before any trusted read",
    async (input) => {
      const f = fixture();
      expect(await f.run(input)).toMatchObject({
        outcome: "invalid_request",
        canSend: false,
      });
      expect(f.preflight).not.toHaveBeenCalled();
      expect(f.readTrustedConsent).not.toHaveBeenCalled();
      expect(f.claimOnce).not.toHaveBeenCalled();
      expect(f.fakeSend).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["worldId", { worldId: target.npcId }],
    ["npcId", { npcId: target.worldId }],
    ["contextId", { contextId: target.npcId }],
    ["interactionId", { interactionId: target.contextId }],
    ["playerEntityId", { playerEntityId: target.npcId }],
    ["sourceMessageId", { sourceMessageId: "1566911648701223066" }],
    ["guildId", { guildId: target.threadId }],
    ["parentId", { parentId: target.threadId }],
    ["threadId", { threadId: target.parentId }],
  ])("denies a valid-shaped but foreign %s", async (_label, change) => {
    const f = fixture();
    expect(await f.run({ ...target, ...change })).toMatchObject({
      outcome: "consent_denied",
      wouldSend: false,
    });
    expect(f.claimOnce).not.toHaveBeenCalled();
    expect(f.fakeSend).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["asserted Discord DM", { ...consent(), issuerRole: "world_dm" }],
    ["revoked", { ...consent(), revokedAt: new Date(eventMs) }],
    ["wrong text", { ...consent(), fixedReply: "Any other text" }],
    ["future issuance", { ...consent(), issuedAt: new Date(eventMs + 2000) }],
    ["expired", { ...consent(), expiresAt: new Date(eventMs + 500) }],
    [
      "overlong window",
      {
        ...consent(),
        issuedAt: new Date(eventMs - 300_000),
        expiresAt: new Date(eventMs + 60_000),
      },
    ],
  ])(
    "blocks %s consent without consuming an attempt",
    async (_label, value) => {
      const f = fixture();
      f.setConsent(value);
      expect(await f.run(target)).toMatchObject({
        outcome: "consent_denied",
        canSend: false,
      });
      expect(f.claimOnce).not.toHaveBeenCalled();
      expect(f.fakeSend).not.toHaveBeenCalled();
    },
  );

  it("blocks a future, aged-out or invalid source ID despite a valid-shaped consent", async () => {
    const f = fixture();
    for (const nowMs of [eventMs - 10, eventMs + 120_001]) {
      const run = createOfflineOneShotPilot({
        preflight: f.preflight,
        readTrustedConsent: f.readTrustedConsent,
        claimOnce: f.claimOnce,
        fakeSend: f.fakeSend,
        clock: () => new Date(nowMs),
      });
      expect(await run(target)).toMatchObject({
        outcome: "consent_denied",
      });
    }
    const invalidSnowflake = "99999999999999999999";
    expect(
      await f.run({ ...target, sourceMessageId: invalidSnowflake }),
    ).toMatchObject({
      outcome: "consent_denied",
    });
    expect(f.fakeSend).not.toHaveBeenCalled();
  });

  it("never accepts a preview as real authority or user-forged send permission", async () => {
    const f = fixture();
    f.setPreview({
      ...preview(),
      canSend: true,
    } as unknown as FirstReplyPreview);
    expect(await f.run(target)).toMatchObject({ outcome: "preflight_denied" });
    f.setPreview({ ...preview(), fixedReply: undefined });
    expect(await f.run(target)).toMatchObject({ outcome: "preflight_denied" });
    f.setPreview({
      ...preview(),
      status: "blocked",
      reason: "host_policy_denied",
    });
    expect(await f.run(target)).toMatchObject({ outcome: "preflight_denied" });
    expect(f.claimOnce).not.toHaveBeenCalled();
  });

  it("refuses a revoked host approval after atomic claim without calling fake transport", async () => {
    const f = fixture();
    f.claimOnce.mockImplementationOnce(async () => {
      f.setConsent({ ...consent(), revokedAt: new Date(eventMs) });
      return true;
    });
    expect(await f.run(target)).toMatchObject({
      outcome: "revoked_after_claim",
    });
    expect(f.fakeSend).not.toHaveBeenCalled();
  });

  it("refuses a changed policy preview after claim", async () => {
    const f = fixture();
    f.claimOnce.mockImplementationOnce(async () => {
      f.setPreview({ ...preview(), status: "blocked" });
      return true;
    });
    expect(await f.run(target)).toMatchObject({
      outcome: "revoked_after_claim",
    });
    expect(f.fakeSend).not.toHaveBeenCalled();
  });

  it("denies operator attribution substitution after claim", async () => {
    const f = fixture();
    f.claimOnce.mockImplementationOnce(async () => {
      f.setConsent({
        ...consent(),
        issuedByOperatorId: "99999999-9999-4999-8999-999999999999",
      });
      return true;
    });
    expect(await f.run(target)).toMatchObject({
      outcome: "revoked_after_claim",
      canSend: false,
    });
    expect(f.fakeSend).not.toHaveBeenCalled();
  });

  it("refuses a substituted consent record after claim", async () => {
    const f = fixture();
    f.claimOnce.mockImplementationOnce(async () => {
      f.setConsent({
        ...consent(),
        id: "88888888-8888-4888-8888-888888888888",
      });
      return true;
    });
    expect(await f.run(target)).toMatchObject({
      outcome: "revoked_after_claim",
    });
    expect(f.fakeSend).not.toHaveBeenCalled();
  });

  it("fail-closes if the atomic consume result is ambiguous", async () => {
    const f = fixture();
    f.claimOnce.mockRejectedValueOnce(new Error("private write failure"));
    const answer = await f.run(target);
    expect(answer).toMatchObject({
      outcome: "claim_uncertain",
      canSend: false,
    });
    expect(JSON.stringify(answer)).not.toContain("private");
    expect(f.fakeSend).not.toHaveBeenCalled();
    expect(f.claimOnce).toHaveBeenCalledTimes(1);
  });

  it.each(["not_sent", "uncertain"] as const)(
    "consumes authorization even after fake transport says %s",
    async (outcome) => {
      const f = fixture();
      f.fakeSend.mockResolvedValueOnce(outcome as never);
      expect(await f.run(target)).toMatchObject({
        outcome: outcome === "not_sent" ? "fake_not_sent" : "fake_uncertain",
        canSend: false,
      });
      expect(await f.run(target)).toMatchObject({
        outcome: "already_consumed",
      });
      expect(f.fakeSend).toHaveBeenCalledTimes(1);
    },
  );

  it("consumes authorization on an ambiguous fake transport exception", async () => {
    const f = fixture();
    f.fakeSend.mockRejectedValueOnce(new Error("lost fake ACK"));
    expect(await f.run(target)).toMatchObject({ outcome: "fake_uncertain" });
    expect(await f.run(target)).toMatchObject({
      outcome: "already_consumed",
    });
    expect(f.fakeSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["NODE_ENV", "production"],
    ["DISCORD_ENABLED", "true"],
    ["DISCORD_OUTBOUND_ENABLED", "true"],
    ["LLM_PROVIDER", "openai"],
    ["LLM_PROVIDER", "fake"],
  ] as const)("does not even read consent with %s=%s", async (key, value) => {
    const f = fixture();
    vi.stubEnv(key, value);
    expect(await f.run(target)).toMatchObject({
      outcome: "offline_only",
      wouldSend: false,
      canSend: false,
    });
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.claimOnce).not.toHaveBeenCalled();
    expect(f.fakeSend).not.toHaveBeenCalled();
  });

  it("does not leak errors returned by a trusted read", async () => {
    const f = fixture();
    f.readTrustedConsent.mockRejectedValueOnce(
      new Error("private SQL and event text"),
    );
    const answer = await f.run(target);
    expect(answer).toMatchObject({
      outcome: "consent_denied",
      readOnly: true,
      canSend: false,
    });
    expect(JSON.stringify(answer)).not.toContain("private");
    expect(f.fakeSend).not.toHaveBeenCalled();
  });
});
