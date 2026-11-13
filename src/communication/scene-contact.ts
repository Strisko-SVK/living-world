import { z } from "zod";
import {
  evaluatePlayerSummon,
  summonFactsSchema,
  type SummonDecision,
} from "./summon-availability.js";

// Only a trusted world-scoped repository may supply these facts. This policy
// cannot authenticate Discord, a player, a DM or a local-presence grant.
const scopeSchema = z
  .object({
    worldId: z.string().uuid(),
    npcId: z.string().uuid(),
    contextId: z.string().uuid(),
  })
  .strict();

const presenceSchema = scopeSchema
  .extend({
    id: z.string().uuid(),
    locationId: z.string().uuid(),
    stateVersion: z.number().int().positive(),
    issuedAt: z.date(),
    revokedAt: z.date().nullable(),
  })
  .strict();

const contactSchema = scopeSchema
  .extend({
    facts: summonFactsSchema,
    presence: presenceSchema.nullable(),
    // Must come from a verified transport event / immutable source ID,
    // never from the request body or an asserted player timestamp.
    sourceEventMs: z.number().int().nonnegative(),
  })
  .strict();

export type SceneContactFacts = z.infer<typeof contactSchema>;

export type SceneContactDecision = {
  path: "unverified" | "direct_in_scene" | "summon_request";
  status:
    | "blocked"
    | "not_available"
    | "delayed"
    | "needs_review"
    | "candidate_needs_review";
  reason:
    | SummonDecision["reason"]
    | "untrusted_facts"
    | "scope_mismatch"
    | "presence_revoked"
    | "presence_stale";
  // An advisory classification is never proof of DM authority,
  // permission to generate, scene relocation or permission to send.
  canGrantPresence: false;
  canGenerate: false;
  canSend: false;
};

function outcome(
  path: SceneContactDecision["path"],
  status: SceneContactDecision["status"],
  reason: SceneContactDecision["reason"],
): SceneContactDecision {
  return {
    path,
    status,
    reason,
    canGrantPresence: false,
    canGenerate: false,
    canSend: false,
  };
}

function fromSummon(decision: SummonDecision): SceneContactDecision {
  const status: SceneContactDecision["status"] =
    decision.status === "candidate"
      ? "candidate_needs_review"
      : decision.status === "unknown"
        ? "needs_review"
        : decision.status;
  return outcome("summon_request", status, decision.reason);
}

// This is a pure advisory policy. The caller MUST verify the original
// Discord message, real bot mention, single NPC target, mapped author,
// world/route and pre-existing local presence at an authoritative DB boundary.
// A missing grant is a summon *request*, not implicit NPC relocation.
// A stale or contradictory grant is BLOCKED, never reinterpreted as a summon.
export function assessSceneContact(input: unknown): SceneContactDecision {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success)
    return outcome("unverified", "blocked", "untrusted_facts");
  const { facts: f, presence, sourceEventMs, ...scope } = parsed.data;

  if (
    f.worldStatus !== "active" ||
    f.npcStatus !== "active" ||
    f.npcLifecycle !== "active" ||
    f.contextStatus !== "active"
  )
    return outcome("unverified", "not_available", "inactive");

  if (f.contextType !== "scene" || !f.sceneLocationId)
    return outcome("unverified", "blocked", "invalid_scene");

  if (!presence) return fromSummon(evaluatePlayerSummon(f));

  if (
    presence.worldId !== scope.worldId ||
    presence.npcId !== scope.npcId ||
    presence.contextId !== scope.contextId
  )
    return outcome("unverified", "blocked", "scope_mismatch");

  if (presence.revokedAt)
    return outcome("unverified", "blocked", "presence_revoked");

  if (
    presence.stateVersion !== f.stateVersion ||
    presence.issuedAt.getTime() > sourceEventMs ||
    presence.locationId !== f.sceneLocationId
  )
    return outcome("unverified", "blocked", "presence_stale");

  if (f.locationCertainty !== "certain" || !f.npcLocationId)
    return outcome("unverified", "blocked", "unknown_location");

  if (f.npcLocationId !== f.sceneLocationId)
    return outcome("unverified", "not_available", "elsewhere");

  // An explicit, trusted pre-event grant proves in-scene contact, but not
  // that the NPC is free, paying attention or clear of competing scenes.
  if (f.otherScene === "active")
    return outcome("direct_in_scene", "not_available", "scene_conflict");
  if (f.activity === "unavailable")
    return outcome("direct_in_scene", "not_available", "activity_unavailable");
  if (f.activity === "busy")
    return outcome("direct_in_scene", "delayed", "activity_busy");
  if (f.perception === "unaware")
    return outcome("direct_in_scene", "not_available", "perception_unaware");
  if (f.activity === "unknown")
    return outcome("direct_in_scene", "needs_review", "activity_unknown");
  if (f.perception === "unknown")
    return outcome("direct_in_scene", "needs_review", "perception_unknown");
  if (f.otherScene === "unknown")
    return outcome("direct_in_scene", "needs_review", "scene_conflict_unknown");

  return outcome("direct_in_scene", "candidate_needs_review", "possible");
}
