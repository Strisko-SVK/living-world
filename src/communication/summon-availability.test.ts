import { describe, expect, it } from "vitest";
import {
  evaluatePlayerSummon,
  type SummonFacts,
} from "./summon-availability.js";

const place = "11111111-1111-4111-8111-111111111111";
const elsewhere = "22222222-2222-4222-8222-222222222222";
const present: SummonFacts = {
  worldStatus: "active",
  npcStatus: "active",
  npcLifecycle: "active",
  contextStatus: "active",
  contextType: "scene",
  sceneLocationId: place,
  npcLocationId: place,
  locationCertainty: "certain",
  stateVersion: 1,
  activity: "free",
  perception: "aware",
  otherScene: "none",
};

describe("player summon availability policy", () => {
  it("recognizes a candidate without authorizing arrival or speech", () => {
    expect(evaluatePlayerSummon(present)).toEqual({
      status: "candidate",
      reason: "possible",
      mayGrantPresence: false,
      maySendSpeech: false,
    });
  });

  it.each([
    [{ npcLocationId: elsewhere }, "elsewhere"],
    [{ npcLifecycle: "dormant" }, "inactive"],
    [{ npcLifecycle: "travelling" }, "inactive"],
    [{ npcLifecycle: "dead" }, "inactive"],
    [{ worldStatus: "archived" }, "inactive"],
    [{ npcStatus: "inactive" }, "inactive"],
    [{ contextStatus: "inactive" }, "inactive"],
    [{ contextType: "direct" }, "invalid_scene"],
    [{ sceneLocationId: null }, "invalid_scene"],
    [{ npcLocationId: null }, "unknown_location"],
    [{ locationCertainty: "probable" }, "unknown_location"],
    [{ locationCertainty: "unknown" }, "unknown_location"],
    [{ otherScene: "active" }, "scene_conflict"],
    [{ activity: "unavailable" }, "activity_unavailable"],
    [{ activity: "busy" }, "activity_busy"],
    [{ activity: "unknown" }, "activity_unknown"],
    [{ perception: "unaware" }, "perception_unaware"],
    [{ perception: "unknown" }, "perception_unknown"],
    [{ otherScene: "unknown" }, "scene_conflict_unknown"],
  ] as const)("never summons when facts include %j", (change, reason) => {
    const result = evaluatePlayerSummon({ ...present, ...change });
    expect(result.reason).toBe(reason);
    expect(result.status).not.toBe("candidate");
    expect(result.mayGrantPresence).toBe(false);
    expect(result.maySendSpeech).toBe(false);
  });

  it.each([
    null,
    {},
    { ...present, isDm: true },
    { ...present, forceArrival: true },
    { ...present, activity: "definitely_free" },
    { ...present, stateVersion: 0 },
    { ...present, sceneLocationId: "invalid" },
  ])("fails closed on incomplete or caller-asserted facts %j", (input) => {
    expect(evaluatePlayerSummon(input)).toMatchObject({
      status: "unknown",
      reason: "invalid_facts",
      mayGrantPresence: false,
      maySendSpeech: false,
    });
  });
});
