import { describe, expect, it } from "vitest";
import {
  assessOfflineSpeechReadiness,
  type OfflineSpeechReadinessRequest,
} from "./scene-speech-readiness.js";

const worldId = "11111111-1111-4111-8111-111111111111";
const npcId = "22222222-2222-4222-8222-222222222222";
const contextId = "33333333-3333-4333-8333-333333333333";
const presenceId = "44444444-4444-4444-8444-444444444444";
const interactionId = "55555555-5555-4555-8555-555555555555";
const actorId = "66666666-6666-4666-8666-666666666666";
const nowMs = 1_800_000_000_000;
const eventMs = nowMs - 1_000;
const snowflakeAt = (ms: number) =>
  String((BigInt(ms) - 1_420_070_400_000n) << 22n);

function fixture(): OfflineSpeechReadinessRequest {
  return {
    worldId,
    npcId,
    contextId,
    presenceId,
    interactionId,
    npcStateVersion: 2,
    sourceMessageId: snowflakeAt(eventMs),
    nowMs,
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
      worldId,
      npcId,
      contextId,
      presenceId,
      npcStateVersion: 2,
      issuedByEntityId: actorId,
      issuedByRole: "world_dm",
      decision: "allow_direct_speech",
      activity: "free",
      perception: "aware",
      otherScene: "none",
      issuedAt: new Date(nowMs - 10 * 60 * 1000),
      expiresAt: new Date(nowMs + 5 * 60 * 1000),
      revokedAt: null,
    },
  };
}

function expectNoLivePermission(output: ReturnType<typeof assessOfflineSpeechReadiness>) {
  expect(output).toMatchObject({
    canGenerate: false,
    canSend: false,
    canGrantPresence: false,
  });
  for (const secret of [worldId, npcId, contextId, presenceId, actorId])
    expect(JSON.stringify(output)).not.toContain(secret);
}

describe("M2.15D bounded direct-scene speech approval (offline only)", () => {
  it("allows only a fake rehearsal with prior, fresh trusted DM evidence", () => {
    const output = assessOfflineSpeechReadiness(fixture());
    expect(output).toMatchObject({
      status: "fake_rehearsal_candidate",
      reason: "approval_valid",
      canRehearseFake: true,
    });
    expectNoLivePermission(output);
  });

  it("allows the later ordinary scene message without per-message approval", () => {
    const base = fixture();
    const later = {
      ...base,
      sourceMessageId: snowflakeAt(eventMs + 500),
    };
    expect(assessOfflineSpeechReadiness(later).status).toBe(
      "fake_rehearsal_candidate",
    );
  });

  it("does not claim permission when no trusted DM observation exists", () => {
    const output = assessOfflineSpeechReadiness({
      ...fixture(),
      approval: null,
    });
    expect(output).toMatchObject({
      status: "needs_review",
      reason: "approval_missing",
      canRehearseFake: false,
    });
    expectNoLivePermission(output);
  });

  it("never authorizes speech for a new summon or uncertain local contact", () => {
    for (const path of ["summon_request", "unverified"]) {
      const base = fixture();
      const output = assessOfflineSpeechReadiness({
        ...base,
        contact: { ...base.contact, path },
      });
      expect(output).toMatchObject({
        status: "blocked",
        reason: "not_direct_scene",
        canRehearseFake: false,
      });
      expectNoLivePermission(output);
    }
  });

  it("cannot override known unavailable, delayed or blocked contact", () => {
    for (const status of ["blocked", "not_available", "delayed"]) {
      const base = fixture();
      const output = assessOfflineSpeechReadiness({
        ...base,
        contact: { ...base.contact, status },
      });
      expect(output).toMatchObject({
        status: "blocked",
        reason: "contact_blocked",
      });
      expectNoLivePermission(output);
    }
  });

  it("blocks revoked, denied and held DM policy without guessing availability", () => {
    for (const change of [
      { revokedAt: new Date(nowMs - 10_000) },
      { decision: "deny" },
      { decision: "hold" },
    ]) {
      const base = fixture();
      const output = assessOfflineSpeechReadiness({
        ...base,
        approval: { ...base.approval!, ...change },
      });
      expect(output.status).toBe("blocked");
      expect(output.canRehearseFake).toBe(false);
      expectNoLivePermission(output);
    }
  });

  it("rejects foreign world, NPC, scene, presence or state revision", () => {
    const base = fixture();
    for (const change of [
      { worldId: npcId },
      { npcId: worldId },
      { contextId: npcId },
      { presenceId: contextId },
      { npcStateVersion: 3 },
    ]) {
      const output = assessOfflineSpeechReadiness({
        ...base,
        approval: { ...base.approval!, ...change },
      });
      expect(output).toMatchObject({
        status: "blocked",
        reason: "approval_scope_mismatch",
      });
      expectNoLivePermission(output);
    }
  });

  it("rejects retroactive approval granted after the source event", () => {
    const base = fixture();
    const output = assessOfflineSpeechReadiness({
      ...base,
      approval: {
        ...base.approval!,
        issuedAt: new Date(eventMs + 1),
      },
    });
    expect(output).toMatchObject({
      status: "blocked",
      reason: "approval_stale",
    });
  });

  it("rejects expired, reversed or overlong scene approval", () => {
    const base = fixture();
    for (const [start, end] of [
      [eventMs - 10_000, nowMs - 1],
      [nowMs + 1, nowMs + 100_000],
      [nowMs - 31 * 60 * 1000, nowMs + 100_000],
      [nowMs - 10_000, nowMs - 20_000],
    ]) {
      const output = assessOfflineSpeechReadiness({
        ...base,
        approval: {
          ...base.approval!,
          issuedAt: new Date(start),
          expiresAt: new Date(end),
        },
      });
      expect(output).toMatchObject({
        status: "blocked",
        reason: "approval_stale",
      });
    }
  });

  it("rejects missing, invalid, future and old source event timestamps", () => {
    const base = fixture();
    const sources = [
      "invalid-snowflake",
      snowflakeAt(nowMs + 60_000),
      snowflakeAt(nowMs - 3 * 60 * 1000),
    ];
    for (const sourceMessageId of sources) {
      const output = assessOfflineSpeechReadiness({ ...base, sourceMessageId });
      expect(output.status).toBe("blocked");
      expect(output.canRehearseFake).toBe(false);
    }
  });

  it("does not let a DM approve busy, unaware or occupied NPC", () => {
    const base = fixture();
    for (const change of [
      { activity: "busy" },
      { activity: "unavailable" },
      { perception: "unaware" },
      { otherScene: "active" },
    ]) {
      const output = assessOfflineSpeechReadiness({
        ...base,
        approval: { ...base.approval!, ...change },
      });
      expect(output.status).toBe("blocked");
      expect(output.canRehearseFake).toBe(false);
      expectNoLivePermission(output);
    }
  });

  it("fails closed on forged DM claims, untrusted source and extra fields", () => {
    const base = fixture();
    for (const invalid of [
      { ...base, isDm: true },
      { ...base, force: "answer" },
      { ...base, nowMs: "later" },
      { ...base, approval: { ...base.approval!, text: "DM approves" } },
      { ...base, approval: { ...base.approval!, issuedByRole: "player" } },
      { ...base, approval: { ...base.approval!, issuedByEntityId: "not-uuid" } },
      { ...base, contact: { ...base.contact, isDm: true } },
      { ...base, contact: { ...base.contact, canSend: true } },
    ]) {
      expect(assessOfflineSpeechReadiness(invalid)).toMatchObject({
        status: "blocked",
        reason: "invalid_facts",
        canRehearseFake: false,
      });
    }
  });

  it("preserves no real permissions even for an already reviewable contact", () => {
    const base = fixture();
    const output = assessOfflineSpeechReadiness({
      ...base,
      contact: {
        ...base.contact,
        status: "candidate_needs_review",
        reason: "possible",
      },
    });
    expect(output.status).toBe("fake_rehearsal_candidate");
    expectNoLivePermission(output);
  });
});
