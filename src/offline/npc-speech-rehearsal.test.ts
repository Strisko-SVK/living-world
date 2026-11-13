import { describe, expect, it, vi } from "vitest";
import type { OfflineSpeechReadinessRequest } from "../communication/scene-speech-readiness.js";
import {
  createOfflineSpeechRehearsal,
  type OfflineSpeechRehearsalDependencies,
  type OfflineSpeechRehearsalScope,
} from "./npc-speech-rehearsal.js";

const scope: OfflineSpeechRehearsalScope = {
  worldId: "11111111-1111-4111-8111-111111111111",
  npcId: "22222222-2222-4222-8222-222222222222",
  contextId: "33333333-3333-4333-8333-333333333333",
  interactionId: "44444444-4444-4444-8444-444444444444",
};
const presenceId = "55555555-5555-4555-8555-555555555555";
const eventTime = 1_800_000_000_000;
const snowflake = String(
  (BigInt(eventTime) - 1_420_070_400_000n) << 22n,
);

function snapshot(): OfflineSpeechReadinessRequest {
  return {
    ...scope,
    presenceId,
    npcStateVersion: 4,
    sourceMessageId: snowflake,
    nowMs: eventTime + 1_000,
    contact: {
      path: "direct_in_scene",
      status: "needs_review",
      reason: "activity_unknown",
      canGrantPresence: false,
      canGenerate: false,
      canSend: false,
    },
    approval: {
      ...scope,
      presenceId,
      npcStateVersion: 4,
      id: "66666666-6666-4666-8666-666666666666",
      issuedByEntityId: "77777777-7777-4777-8777-777777777777",
      issuedByRole: "world_dm",
      decision: "allow_direct_speech",
      activity: "free",
      perception: "aware",
      otherScene: "none",
      issuedAt: new Date(eventTime - 60_000),
      expiresAt: new Date(eventTime + 60_000),
      revokedAt: null,
    },
  };
}

function fixture() {
  const readTrustedSnapshot = vi.fn(async () => snapshot());
  const runFake = vi.fn(async () => "ack" as const);
  const diagnose = vi.fn();
  const deps: OfflineSpeechRehearsalDependencies = {
    readTrustedSnapshot,
    runFake,
    diagnose,
  };
  return {
    deps,
    readTrustedSnapshot,
    runFake,
    diagnose,
    run: createOfflineSpeechRehearsal(deps),
  };
}

describe("M2.15D fake-only scene speech rehearsal", () => {
  it("makes one synthetic acknowledgement after a valid prior DM scene decision", async () => {
    const f = fixture();
    expect(await f.run(scope)).toBe("fake_ack");
    expect(f.readTrustedSnapshot).toHaveBeenCalledExactlyOnceWith(scope);
    expect(f.runFake).toHaveBeenCalledExactlyOnceWith(scope);
    expect(f.diagnose).toHaveBeenCalledWith({
      event: "npc_speech_rehearsal",
      outcome: "fake_ack",
    });
  });

  it("does not read or send in non-test, outbound-enabled or paid-provider mode", async () => {
    const f = fixture();
    for (const [key, value] of [
      ["NODE_ENV", "production"],
      ["DISCORD_ENABLED", "true"],
      ["DISCORD_OUTBOUND_ENABLED", "true"],
      ["LLM_PROVIDER", "openai"],
    ] as const) {
      vi.stubEnv(key, value);
      try {
        expect(await f.run(scope)).toBe("offline_only");
      } finally {
        vi.unstubAllEnvs();
      }
    }
    expect(f.readTrustedSnapshot).not.toHaveBeenCalled();
    expect(f.runFake).not.toHaveBeenCalled();
  });

  it("rejects unvalidated or spoofed DM scope before reading a snapshot", async () => {
    const f = fixture();
    for (const input of [
      { ...scope, isDm: true },
      { ...scope, interactionId: "wrong" },
      { ...scope, worldId: "another-world" },
      { ...scope, role: "dm" },
    ]) {
      expect(await f.run(input as OfflineSpeechRehearsalScope)).toBe(
        "invalid_scope",
      );
    }
    expect(f.readTrustedSnapshot).not.toHaveBeenCalled();
    expect(f.runFake).not.toHaveBeenCalled();
  });

  it("refuses absent, foreign and mismatched trusted source snapshots", async () => {
    const f = fixture();
    f.readTrustedSnapshot.mockResolvedValueOnce(null as never);
    expect(await f.run(scope)).toBe("missing_snapshot");
    for (const change of [
      { worldId: scope.npcId },
      { npcId: scope.worldId },
      { contextId: scope.worldId },
      { interactionId: scope.worldId },
    ]) {
      f.readTrustedSnapshot.mockResolvedValueOnce({
        ...snapshot(),
        ...change,
      });
      expect(await f.run(scope)).toBe("ineligible");
    }
    expect(f.runFake).not.toHaveBeenCalled();
  });

  it("never runs a fake response without matching, non-revoked DM evidence", async () => {
    const f = fixture();
    for (const patch of [
      { approval: null },
      {
        approval: {
          ...snapshot().approval!,
          revokedAt: new Date(eventTime - 100),
        },
      },
      { contact: { ...snapshot().contact, path: "summon_request" } },
      {
        approval: {
          ...snapshot().approval!,
          issuedAt: new Date(eventTime + 1),
        },
      },
    ]) {
      f.readTrustedSnapshot.mockResolvedValueOnce({
        ...snapshot(),
        ...patch,
      } as OfflineSpeechReadinessRequest);
      expect(await f.run(scope)).toBe("ineligible");
    }
    expect(f.runFake).not.toHaveBeenCalled();
  });

  it("reports fake delivery failure or uncertain ACK without automatically retrying", async () => {
    const f = fixture();
    f.runFake.mockResolvedValueOnce("blocked" as never);
    expect(await f.run(scope)).toBe("fake_blocked");
    f.runFake.mockResolvedValueOnce("uncertain" as never);
    expect(await f.run(scope)).toBe("fake_uncertain");
    f.runFake.mockRejectedValueOnce(Error("private fake transport error"));
    expect(await f.run(scope)).toBe("fake_uncertain");
    expect(f.runFake).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(f.diagnose.mock.calls)).not.toContain(
      "private fake transport error",
    );
  });

  it("cannot let diagnostic exceptions authorize or re-run a blocked policy", async () => {
    const f = fixture();
    f.diagnose.mockImplementation(() => {
      throw Error("private logger crashed");
    });
    f.readTrustedSnapshot.mockResolvedValueOnce({
      ...snapshot(),
      approval: null,
    } as never);
    expect(await f.run(scope)).toBe("ineligible");
    expect(f.runFake).not.toHaveBeenCalled();
  });
});
