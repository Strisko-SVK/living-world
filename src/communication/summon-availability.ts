import { z } from "zod";
import {
  entityStatusValues,
  interactionContextStatusValues,
  interactionContextTypeValues,
  locationCertaintyValues,
  npcLifecycleStateValues,
  worldStatusValues,
} from "../db/schema/enums.js";

// These are facts assembled by a trusted world-scoped repository, not by
// Discord content or a model. Availability/activity evidence is deliberately
// separate from the human-readable NPC state summary.
export const summonFactsSchema = z
  .object({
    worldStatus: z.enum(worldStatusValues),
    npcStatus: z.enum(entityStatusValues),
    npcLifecycle: z.enum(npcLifecycleStateValues),
    contextStatus: z.enum(interactionContextStatusValues),
    contextType: z.enum(interactionContextTypeValues),
    sceneLocationId: z.string().uuid().nullable(),
    npcLocationId: z.string().uuid().nullable(),
    locationCertainty: z.enum(locationCertaintyValues),
    stateVersion: z.number().int().positive(),
    activity: z.enum(["free", "busy", "unavailable", "unknown"]),
    perception: z.enum(["aware", "unaware", "unknown"]),
    otherScene: z.enum(["none", "active", "unknown"]),
  })
  .strict();

export type SummonFacts = z.infer<typeof summonFactsSchema>;
export type SummonDecision = {
  status: "candidate" | "delayed" | "not_available" | "unknown";
  reason:
    | "invalid_facts"
    | "inactive"
    | "invalid_scene"
    | "unknown_location"
    | "elsewhere"
    | "scene_conflict"
    | "activity_unavailable"
    | "activity_busy"
    | "activity_unknown"
    | "perception_unaware"
    | "perception_unknown"
    | "scene_conflict_unknown"
    | "possible";
  // A summon is a request, never permission to move or speak. A later
  // transactional presence transition and response fence must still succeed.
  mayGrantPresence: false;
  maySendSpeech: false;
};

export function evaluatePlayerSummon(input: unknown): SummonDecision {
  const parsed = summonFactsSchema.safeParse(input);
  const answer = (
    status: SummonDecision["status"],
    reason: SummonDecision["reason"],
  ): SummonDecision => ({
    status,
    reason,
    mayGrantPresence: false,
    maySendSpeech: false,
  });
  if (!parsed.success) return answer("unknown", "invalid_facts");
  const f = parsed.data;
  if (
    f.worldStatus !== "active" ||
    f.npcStatus !== "active" ||
    f.npcLifecycle !== "active" ||
    f.contextStatus !== "active"
  )
    return answer("not_available", "inactive");
  if (f.contextType !== "scene" || !f.sceneLocationId)
    return answer("unknown", "invalid_scene");
  if (f.locationCertainty !== "certain" || !f.npcLocationId)
    return answer("unknown", "unknown_location");
  if (f.npcLocationId !== f.sceneLocationId)
    return answer("not_available", "elsewhere");
  if (f.otherScene === "active")
    return answer("not_available", "scene_conflict");
  if (f.activity === "unavailable")
    return answer("not_available", "activity_unavailable");
  if (f.activity === "busy") return answer("delayed", "activity_busy");
  if (f.activity === "unknown")
    return answer("unknown", "activity_unknown");
  if (f.perception === "unaware")
    return answer("not_available", "perception_unaware");
  if (f.perception === "unknown")
    return answer("unknown", "perception_unknown");
  if (f.otherScene === "unknown")
    return answer("unknown", "scene_conflict_unknown");
  return answer("candidate", "possible");
}
