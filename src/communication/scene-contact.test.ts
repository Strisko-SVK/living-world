import { describe, expect, it } from "vitest";
import {
  assessSceneContact,
  type SceneContactFacts,
} from "./scene-contact.js";

const worldId = "11111111-1111-4111-8111-111111111111";
const npcId = "22222222-2222-4222-8222-222222222222";
const contextId = "33333333-3333-4333-8333-333333333333";
const location = "44444444-4444-4444-8444-444444444444";
const sourceEventMs = 1_800_000_000_000;

function fixture(): SceneContactFacts {
  return {
    worldId,
    npcId,
    contextId,
    sourceEventMs,
    facts: {
      worldStatus: "active",
      npcStatus: "active",
      npcLifecycle: "active",
      contextStatus: "active",
      contextType: "scene",
      sceneLocationId: location,
      npcLocationId: location,
      locationCertainty: "certain",
      stateVersion: 2,
      activity: "unknown",
      perception: "unknown",
      otherScene: "unknown",
    },
    presence: {
      id: "55555555-5555-4555-8555-555555555555",
      worldId,
      npcId,
      contextId,
      locationId: location,
      stateVersion: 2,
      issuedAt: new Date(sourceEventMs - 1000),
      revokedAt: null,
    },
  };
}

function expectNoAction(result: ReturnType<typeof assessSceneContact>) {
  expect(result).toMatchObject({
    canGrantPresence: false,
    canGenerate: false,
    canSend: false,
  });
  for (const privateValue of [worldId, npcId, contextId, location])
    expect(JSON.stringify(result)).not.toContain(privateValue);
}

describe("M2.15C trusted scene contact advisory (never speech authorization)", () => {
  it("classifies an existing pre-event grant as direct address with unknown activity", () => {
    const result = assessSceneContact(fixture());
    expect(result).toMatchObject({
      path: "direct_in_scene",
      status: "needs_review",
      reason: "activity_unknown",
    });
    expectNoAction(result);
  });

  it("does not equate a missing grant to local speech or a teleport", () => {
    const result = assessSceneContact({ ...fixture(), presence: null });
    expect(result).toMatchObject({
      path: "summon_request",
      status: "needs_review",
      reason: "activity_unknown",
    });
    expectNoAction(result);
  });

  it("keeps absent NPC summons separate and cannot retro-authorize an older message", () => {
    const input = fixture();
    const elsewhere = "66666666-6666-4666-8666-666666666666";
    const absent = assessSceneContact({
      ...input,
      presence: null,
      facts: { ...input.facts, npcLocationId: elsewhere },
    });
    expect(absent).toMatchObject({
      path: "summon_request",
      status: "not_available",
      reason: "elsewhere",
    });
    const stale = assessSceneContact({
      ...input,
      sourceEventMs: input.sourceEventMs - 2000,
    });
    expect(stale).toMatchObject({
      path: "unverified",
      status: "blocked",
      reason: "presence_stale",
    });
    expectNoAction(absent);
    expectNoAction(stale);
  });

  it("blocks revoked, foreign, replaced and stale local evidence", () => {
    const base = fixture();
    const cases: Array<{
      changed: unknown;
      reason: string;
    }> = [
      {
        changed: {
          ...base,
          presence: { ...base.presence!, revokedAt: new Date() },
        },
        reason: "presence_revoked",
      },
      {
        changed: {
          ...base,
          presence: { ...base.presence!, worldId: npcId },
        },
        reason: "scope_mismatch",
      },
      {
        changed: {
          ...base,
          presence: { ...base.presence!, npcId: worldId },
        },
        reason: "scope_mismatch",
      },
      {
        changed: {
          ...base,
          presence: { ...base.presence!, contextId: worldId },
        },
        reason: "scope_mismatch",
      },
      {
        changed: {
          ...base,
          facts: { ...base.facts, stateVersion: 3 },
        },
        reason: "presence_stale",
      },
      {
        changed: {
          ...base,
          presence: { ...base.presence!, locationId: npcId },
        },
        reason: "presence_stale",
      },
      {
        changed: {
          ...base,
          presence: { ...base.presence!, issuedAt: new Date(sourceEventMs + 1) },
        },
        reason: "presence_stale",
      },
    ];
    for (const { changed, reason } of cases) {
      const result = assessSceneContact(changed);
      expect(result).toMatchObject({
        path: "unverified",
        status: "blocked",
        reason,
      });
      expectNoAction(result);
    }
  });

  it("rejects wrong context, mismatched NPC location and inactive world", () => {
    const base = fixture();
    for (const changed of [
      { ...base, facts: { ...base.facts, worldStatus: "inactive" } },
      { ...base, facts: { ...base.facts, npcLifecycle: "inactive" } },
      { ...base, facts: { ...base.facts, npcStatus: "inactive" } },
      { ...base, facts: { ...base.facts, contextStatus: "inactive" } },
    ]) {
      expect(assessSceneContact(changed)).toMatchObject({
        path: "unverified",
        status: "not_available",
        reason: "inactive",
      });
    }
    expect(
      assessSceneContact({
        ...base,
        facts: { ...base.facts, contextType: "thread" },
      }),
    ).toMatchObject({ path: "unverified", status: "blocked" });
    expect(
      assessSceneContact({
        ...base,
        facts: { ...base.facts, locationCertainty: "unknown" },
      }),
    ).toMatchObject({
      path: "unverified",
      status: "blocked",
      reason: "unknown_location",
    });
    expect(
      assessSceneContact({
        ...base,
        facts: { ...base.facts, npcLocationId: npcId },
      }),
    ).toMatchObject({
      path: "unverified",
      status: "not_available",
      reason: "elsewhere",
    });
  });

  it("distinguishes busy, unavailable, unaware and competing scenes", () => {
    const base = fixture();
    const cases = [
      { facts: { ...base.facts, otherScene: "active" }, status: "not_available", reason: "scene_conflict" },
      { facts: { ...base.facts, activity: "busy" }, status: "delayed", reason: "activity_busy" },
      { facts: { ...base.facts, activity: "unavailable" }, status: "not_available", reason: "activity_unavailable" },
      { facts: { ...base.facts, activity: "free", perception: "unaware" }, status: "not_available", reason: "perception_unaware" },
      { facts: { ...base.facts, activity: "free" }, status: "needs_review", reason: "perception_unknown" },
      { facts: { ...base.facts, activity: "free", perception: "aware" }, status: "needs_review", reason: "scene_conflict_unknown" },
      { facts: { ...base.facts, activity: "free", perception: "aware", otherScene: "none" }, status: "candidate_needs_review", reason: "possible" },
    ] as const;
    for (const testCase of cases) {
      const result = assessSceneContact({ ...base, facts: testCase.facts });
      expect(result).toMatchObject({
        path: "direct_in_scene",
        status: testCase.status,
        reason: testCase.reason,
      });
      expectNoAction(result);
    }
  });

  it("fails closed for fabricated DM claims, untrusted state and invalid timestamps", () => {
    const base = fixture();
    const invalid = [
      null,
      "direct_in_scene",
      {},
      { ...base, isDm: true },
      { ...base, forceArrive: true },
      { ...base, sourceEventMs: "yesterday" },
      { ...base, sourceEventMs: Number.NaN },
      { ...base, sourceEventMs: -1 },
      { ...base, presence: { ...base.presence!, issuedAt: "yesterday" } },
      { ...base, facts: { ...base.facts, activity: "free", dmApproved: true } },
      { ...base, facts: { ...base.facts, activity: "free", otherScene: "none", perception: "guessed" } },
    ];
    for (const item of invalid) {
      const result = assessSceneContact(item);
      expect(result).toMatchObject({
        path: "unverified",
        status: "blocked",
        reason: "untrusted_facts",
      });
      expectNoAction(result);
    }
  });
});
