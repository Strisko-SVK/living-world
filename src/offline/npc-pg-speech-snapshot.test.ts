import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readVerifiedOfflineSpeechSnapshot,
  readVerifiedOfflineSpeechPhaseSnapshot,
} from "./npc-pg-speech-snapshot.js";

const scope = {
  worldId: "11111111-1111-4111-8111-111111111111",
  npcId: "22222222-2222-4222-8222-222222222222",
  contextId: "33333333-3333-4333-8333-333333333333",
  interactionId: "44444444-4444-4444-8444-444444444444",
};

const mockDb = () => {
  const transaction = vi.fn();
  return {
    transaction,
    db: { transaction } as unknown as Parameters<
      typeof readVerifiedOfflineSpeechSnapshot
    >[0],
  };
};

function safeTestMode() {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DISCORD_ENABLED", "false");
  vi.stubEnv("DISCORD_OUTBOUND_ENABLED", "false");
  vi.stubEnv("LLM_PROVIDER", "disabled");
}

afterEach(() => vi.unstubAllEnvs());

describe("M2.15G PostgreSQL-bound offline speech safety", () => {
  it("denies even DB access outside the exact fake-only CI configuration", async () => {
    const f = mockDb();
    safeTestMode();
    for (const [name, value] of [
      ["NODE_ENV", "production"],
      ["DISCORD_ENABLED", "true"],
      ["DISCORD_OUTBOUND_ENABLED", "true"],
      ["LLM_PROVIDER", "openai"],
      ["LLM_PROVIDER", ""],
    ] as const) {
      vi.stubEnv(name, value);
      try {
        expect(await readVerifiedOfflineSpeechSnapshot(f.db, scope)).toBeNull();
      } finally {
        safeTestMode();
      }
    }
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("refuses foreign, invalid or role-claiming scopes before the DB boundary", async () => {
    safeTestMode();
    const f = mockDb();
    for (const raw of [
      null,
      {},
      { ...scope, npcId: "invalid" },
      { ...scope, isDm: true },
      { ...scope, issuedByRole: "host_operator" },
      { ...scope, activity: "free" },
      { ...scope, token: "spoofed" },
    ]) {
      expect(await readVerifiedOfflineSpeechSnapshot(f.db, raw)).toBeNull();
    }
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("never accepts a caller-forged or unknown response phase", async () => {
    safeTestMode();
    const f = mockDb();
    const phase = "send_without_claim" as Parameters<
      typeof readVerifiedOfflineSpeechPhaseSnapshot
    >[2];
    expect(
      await readVerifiedOfflineSpeechPhaseSnapshot(f.db, scope, phase),
    ).toBeNull();
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("fails closed and redacts unexpected DB exceptions without retries", async () => {
    safeTestMode();
    const f = mockDb();
    f.transaction.mockRejectedValueOnce(
      new Error("DO_NOT_EXPOSE_PRIVATE_DATABASE_CONTENT"),
    );
    const value = await readVerifiedOfflineSpeechSnapshot(f.db, scope);
    expect(value).toBeNull();
    expect(f.transaction).toHaveBeenCalledOnce();
  });
});
