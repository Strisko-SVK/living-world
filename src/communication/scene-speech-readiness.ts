import { z } from "zod";
import { discordMessageCreatedAt } from "../intake/discord-snowflake.js";
import type { SceneContactDecision } from "./scene-contact.js";

// This is an advisory, offline-only policy. It cannot authenticate a DM,
// persist approval, prepare a response, call a model or deliver to Discord.
// The future repository must authenticate issuer authority and return only
// provenance-bearing, non-revoked policy records from the same world.
const scope = z
  .object({
    worldId: z.string().uuid(),
    npcId: z.string().uuid(),
    contextId: z.string().uuid(),
    presenceId: z.string().uuid(),
    npcStateVersion: z.number().int().positive(),
  })
  .strict();

const approvalSchema = scope
  .extend({
    id: z.string().uuid(),
    issuedByEntityId: z.string().uuid(),
    issuedByRole: z.enum(["world_dm", "host_operator"]),
    decision: z.enum(["allow_direct_speech", "hold", "deny"]),
    activity: z.enum(["free", "busy", "unavailable"]),
    perception: z.enum(["aware", "unaware"]),
    otherScene: z.enum(["none", "active"]),
    issuedAt: z.date(),
    expiresAt: z.date(),
    revokedAt: z.date().nullable(),
  })
  .strict();

const requestSchema = scope
  .extend({
    interactionId: z.string().uuid(),
    // The original, authenticated Discord event identity. Never take the
    // source time from player text or from a caller-supplied Date.
    sourceMessageId: z.string().regex(/^\d{17,20}$/u),
    nowMs: z.number().int().nonnegative(),
    contact: z
      .object({
        path: z.enum(["unverified", "direct_in_scene", "summon_request"]),
        status: z.enum([
          "blocked",
          "not_available",
          "delayed",
          "needs_review",
          "candidate_needs_review",
        ]),
        reason: z.string().min(1),
        canGrantPresence: z.literal(false),
        canGenerate: z.literal(false),
        canSend: z.literal(false),
      })
      .strict(),
    approval: approvalSchema.nullable(),
  })
  .strict();

export type OfflineSpeechReadinessRequest = z.infer<typeof requestSchema>;
export type TrustedSceneSpeechApproval = z.infer<typeof approvalSchema>;

export type SpeechReadinessResult = {
  status: "blocked" | "needs_review" | "fake_rehearsal_candidate";
  reason:
    | "invalid_facts"
    | "not_direct_scene"
    | "contact_blocked"
    | "source_stale"
    | "approval_missing"
    | "approval_scope_mismatch"
    | "approval_stale"
    | "approval_revoked"
    | "approval_denied"
    | "npc_busy"
    | "npc_unaware"
    | "scene_conflict"
    | "approval_valid";
  // This is never a production speech or delivery permission.
  canRehearseFake: boolean;
  canGenerate: false;
  canSend: false;
  canGrantPresence: false;
};

const maxPolicyDurationMs = 30 * 60 * 1000;
const maxEventAgeMs = 2 * 60 * 1000;

function result(
  status: SpeechReadinessResult["status"],
  reason: SpeechReadinessResult["reason"],
): SpeechReadinessResult {
  return {
    status,
    reason,
    canRehearseFake: status === "fake_rehearsal_candidate",
    canGenerate: false,
    canSend: false,
    canGrantPresence: false,
  };
}

// Approval applies to NEW source events received after the policy was issued,
// not the already-consumed Sentinel inbound that preceded this feature.
// Existing M2.9 presence, mapped-player, route and delivery fences must still
// be enforced at the real transactional action boundary.
export function assessOfflineSpeechReadiness(
  input: unknown,
): SpeechReadinessResult {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return result("blocked", "invalid_facts");
  const r = parsed.data;
  const eventMs = discordMessageCreatedAt(r.sourceMessageId);
  if (
    eventMs === null ||
    eventMs > r.nowMs ||
    r.nowMs - eventMs > maxEventAgeMs
  )
    return result("blocked", "source_stale");

  if (r.contact.path !== "direct_in_scene")
    return result("blocked", "not_direct_scene");
  if (
    r.contact.status !== "needs_review" &&
    r.contact.status !== "candidate_needs_review"
  )
    return result("blocked", "contact_blocked");

  const a = r.approval;
  if (!a) return result("needs_review", "approval_missing");

  if (
    a.worldId !== r.worldId ||
    a.npcId !== r.npcId ||
    a.contextId !== r.contextId ||
    a.presenceId !== r.presenceId ||
    a.npcStateVersion !== r.npcStateVersion
  )
    return result("blocked", "approval_scope_mismatch");
  if (a.revokedAt !== null) return result("blocked", "approval_revoked");
  if (a.decision !== "allow_direct_speech")
    return result("blocked", "approval_denied");

  const start = a.issuedAt.getTime();
  const end = a.expiresAt.getTime();
  if (
    end <= start ||
    end - start > maxPolicyDurationMs ||
    start > eventMs ||
    end <= eventMs ||
    end <= r.nowMs
  )
    return result("blocked", "approval_stale");

  if (a.activity !== "free") return result("blocked", "npc_busy");
  if (a.perception !== "aware") return result("blocked", "npc_unaware");
  if (a.otherScene !== "none") return result("blocked", "scene_conflict");

  return result("fake_rehearsal_candidate", "approval_valid");
}

export function isDirectSceneContact(contact: SceneContactDecision): boolean {
  return contact.path === "direct_in_scene";
}
