export type LocalDenial =
  | "missing"
  | "inactive"
  | "invalid_scene"
  | "unknown_location"
  | "location_mismatch"
  | "revoked"
  | "stale"
  | "unsupported_remote"
  | "policy_disabled";
export interface LocalFacts {
  active: boolean;
  scene: boolean;
  locationId: string | null;
  currentLocationId: string | null;
  certain: boolean;
  stateVersion: number;
}
export interface PresenceEvidence {
  locationId: string;
  stateVersion: number;
  issuedAt: Date;
  revokedAt: Date | null;
}
export type LocalEligibility =
  { status: "eligible_local" } | { status: "blocked"; reason: LocalDenial };
export function evaluateLocal(
  facts: LocalFacts | undefined,
  evidence: PresenceEvidence | undefined,
  receivedAt?: Date,
  mode?: string,
): LocalEligibility {
  const blocked = (reason: LocalDenial): LocalEligibility => ({
    status: "blocked",
    reason,
  });
  if (mode === "remote") return blocked("unsupported_remote");
  if (!facts) return blocked("missing");
  if (!facts.active) return blocked("inactive");
  if (!facts.scene || !facts.locationId) return blocked("invalid_scene");
  if (!facts.certain || !facts.currentLocationId)
    return blocked("unknown_location");
  if (facts.currentLocationId !== facts.locationId)
    return blocked("location_mismatch");
  if (!evidence) return blocked("missing");
  if (evidence.revokedAt) return blocked("revoked");
  if (
    evidence.locationId !== facts.locationId ||
    evidence.stateVersion !== facts.stateVersion ||
    (receivedAt && receivedAt < evidence.issuedAt)
  )
    return blocked("stale");
  return { status: "eligible_local" };
}
