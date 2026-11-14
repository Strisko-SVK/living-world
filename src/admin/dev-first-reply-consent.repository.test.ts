import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimDevOneShotConsent,
  issueDevOneShotConsent,
  revokeDevOneShotConsent,
} from "./dev-first-reply-consent.repository.js";

const request = {
  worldKey: "lw-dev-first-reply-001",
  worldId: "11111111-1111-4111-8111-111111111111",
  npcId: "22222222-2222-4222-8222-222222222222",
  contextId: "33333333-3333-4333-8333-333333333333",
  interactionId: "44444444-4444-4444-8444-444444444444",
  playerEntityId: "55555555-5555-4555-8555-555555555555",
  playerDiscordId: "1888888888888888888",
  sourceMessageId: "1888888888888888999",
  guildId: "1566911648701223053",
  parentId: "1888888888888888001",
  threadId: "1888888888888888002",
  operatorEntityId: "66666666-6666-4666-8666-666666666666",
};

function noDatabase() {
  const transaction = vi.fn();
  return {
    transaction,
    database: { transaction } as unknown as Parameters<
      typeof issueDevOneShotConsent
    >[0],
  };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DISCORD_ENABLED", "false");
  vi.stubEnv("DISCORD_OUTBOUND_ENABLED", "false");
  vi.stubEnv("LLM_PROVIDER", "disabled");
});

afterEach(() => vi.unstubAllEnvs());

describe("M2.15M persisted DEV one-shot operator boundary", () => {
  it("never treats an unverified or malformed issue as authorization", async () => {
    const { database, transaction } = noDatabase();
    for (const attempted of [
      { ...request, ttlSeconds: 0 },
      { ...request, ttlSeconds: 121 },
      { ...request, ttlSeconds: 60, execute: true },
      { ...request, ttlSeconds: 60, ownerApproved: true },
      { ...request, ttlSeconds: 60, claimedDmRole: "world_dm" },
      { ...request, ttlSeconds: 60, threadId: "foreign" },
      { ...request, ttlSeconds: 60, operatorEntityId: "not-a-uuid" },
    ]) {
      expect(await issueDevOneShotConsent(database, attempted)).toEqual({
        event: "npc_dev_one_shot_consent",
        status: "invalid_request",
        readOnly: false,
        canGenerate: false,
        canSend: false,
        wouldSend: false,
      });
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a claim or revoke without an exact scoped consent ID", async () => {
    const { database, transaction } = noDatabase();
    for (const fn of [claimDevOneShotConsent, revokeDevOneShotConsent]) {
      for (const attempted of [
        { ...request },
        { ...request, consentId: "not-a-uuid" },
        { ...request, consentId: request.interactionId, force: true },
      ]) {
        expect(await fn(database, attempted)).toMatchObject({
          status: "invalid_request",
          canSend: false,
          canGenerate: false,
        });
      }
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["NODE_ENV", "production"],
    ["DISCORD_ENABLED", "true"],
    ["DISCORD_OUTBOUND_ENABLED", "true"],
    ["LLM_PROVIDER", "openai"],
    ["LLM_PROVIDER", "fake"],
  ] as const)("refuses all DB access when %s is %s", async (name, value) => {
    const { database, transaction } = noDatabase();
    vi.stubEnv(name, value);
    expect(
      await issueDevOneShotConsent(database, { ...request, ttlSeconds: 60 }),
    ).toMatchObject({ status: "operator_only", canSend: false });
    expect(
      await claimDevOneShotConsent(database, {
        ...request,
        consentId: request.interactionId,
      }),
    ).toMatchObject({ status: "operator_only", canSend: false });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("sanitizes any unexpected DB failure without granting send permission", async () => {
    const transaction = vi.fn().mockRejectedValue(
      new Error("SECRET: local DEV password and player message"),
    );
    const db = { transaction } as unknown as Parameters<
      typeof issueDevOneShotConsent
    >[0];
    const result = await issueDevOneShotConsent(db, {
      ...request,
      ttlSeconds: 60,
    });
    expect(result).toMatchObject({
      status: "blocked",
      canSend: false,
      canGenerate: false,
      wouldSend: false,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
