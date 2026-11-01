import { describe, expect, it } from "vitest";
import {
  evaluateLocal,
  type LocalFacts,
  type PresenceEvidence,
} from "./eligibility.js";
const facts: LocalFacts = {
  active: true,
  scene: true,
  locationId: "place",
  currentLocationId: "place",
  certain: true,
  stateVersion: 3,
};
const evidence: PresenceEvidence = {
  locationId: "place",
  stateVersion: 3,
  issuedAt: new Date(1000),
  revokedAt: null,
};
describe("deterministic local eligibility", () => {
  it("allows exact active scene evidence issued before receipt", () => {
    expect(evaluateLocal(facts, evidence, new Date(2000))).toEqual({
      status: "eligible_local",
    });
  });
  it.each([
    [undefined, evidence, "missing"],
    [{ ...facts, active: false }, evidence, "inactive"],
    [{ ...facts, scene: false }, evidence, "invalid_scene"],
    [{ ...facts, locationId: null }, evidence, "invalid_scene"],
    [{ ...facts, certain: false }, evidence, "unknown_location"],
    [{ ...facts, currentLocationId: null }, evidence, "unknown_location"],
    [
      { ...facts, currentLocationId: "elsewhere" },
      evidence,
      "location_mismatch",
    ],
    [facts, undefined, "missing"],
    [facts, { ...evidence, revokedAt: new Date(1500) }, "revoked"],
    [facts, { ...evidence, stateVersion: 2 }, "stale"],
    [facts, { ...evidence, locationId: "other" }, "stale"],
  ] as const)("blocks invalid facts/evidence %#", (f, e, reason) => {
    expect(evaluateLocal(f, e, new Date(2000))).toEqual({
      status: "blocked",
      reason,
    });
  });
  it("does not retroactively authorize old events", () => {
    expect(evaluateLocal(facts, evidence, new Date(999))).toEqual({
      status: "blocked",
      reason: "stale",
    });
  });
  it("leaves remote unsupported", () => {
    expect(evaluateLocal(facts, evidence, new Date(2000), "remote")).toEqual({
      status: "blocked",
      reason: "unsupported_remote",
    });
  });
});
