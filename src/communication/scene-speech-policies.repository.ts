import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import { worlds } from "../db/schema/worlds.js";
import { entities } from "../db/schema/entities.js";
import { npcs } from "../db/schema/npcs.js";
import { npcState } from "../db/schema/npc-state.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { localPresence } from "../db/schema/local-presence.js";
import { sceneSpeechPolicies } from "../db/schema/scene-speech-policies.js";
import { lockLocalContext } from "./local.repository.js";
import type { TrustedSceneSpeechApproval } from "./scene-speech-readiness.js";

type Database = Omit<DatabaseClient["db"], "$client">;

const scopeSchema = z
  .object({
    worldId: z.string().uuid(),
    npcId: z.string().uuid(),
    contextId: z.string().uuid(),
    presenceId: z.string().uuid(),
  })
  .strict();
type Scope = z.infer<typeof scopeSchema>;

const issueSchema = scopeSchema
  .extend({
    // Label for audit only. Host access to isolated DB is the issuer's
    // authentication. No asserted Discord or DM role is trusted here.
    issuerEntityId: z.string().uuid(),
    decision: z.enum(["allow_direct_speech", "hold", "deny"]),
    activity: z.enum(["free", "busy", "unavailable"]),
    perception: z.enum(["aware", "unaware"]),
    otherScene: z.enum(["none", "active"]),
    ttlMinutes: z.number().int().min(1).max(30),
  })
  .strict();

const allowedDatabases = new Map([
  ["living_world_ci", "living_world_ci"],
  ["living_world_gateway_dev", "lw_gateway_dev"],
]);

async function authorizedHost(tx: Database): Promise<boolean> {
  const r = await tx.execute(
    sql`select current_database() as database, current_user as db_role`,
  );
  const row = r.rows[0];
  return (
    typeof row?.database === "string" &&
    typeof row.db_role === "string" &&
    allowedDatabases.get(row.database) === row.db_role
  );
}

const whereScope = (scope: Scope) =>
  and(
    eq(sceneSpeechPolicies.worldId, scope.worldId),
    eq(sceneSpeechPolicies.npcId, scope.npcId),
    eq(sceneSpeechPolicies.contextId, scope.contextId),
    eq(sceneSpeechPolicies.presenceId, scope.presenceId),
  );

async function validScene(tx: Database, scope: Scope) {
  const [world] = await tx
    .select({ status: worlds.status })
    .from(worlds)
    .where(eq(worlds.id, scope.worldId))
    .for("share");
  const [context] = await tx
    .select({
      status: interactionContexts.status,
      type: interactionContexts.contextType,
      policy: interactionContexts.npcIntakePolicy,
      locationId: interactionContexts.linkedLocationEntityId,
    })
    .from(interactionContexts)
    .where(
      and(
        eq(interactionContexts.worldId, scope.worldId),
        eq(interactionContexts.id, scope.contextId),
      ),
    )
    .for("share");
  const [entity] = await tx
    .select({
      status: entities.status,
      type: entities.entityType,
    })
    .from(entities)
    .where(
      and(eq(entities.worldId, scope.worldId), eq(entities.id, scope.npcId)),
    )
    .for("share");
  const [npc] = await tx
    .select({ lifecycle: npcs.lifecycleState })
    .from(npcs)
    .where(eq(npcs.entityId, scope.npcId))
    .for("share");
  const [state] = await tx
    .select()
    .from(npcState)
    .where(eq(npcState.npcId, scope.npcId))
    .for("share");
  const [presence] = await tx
    .select()
    .from(localPresence)
    .where(
      and(
        eq(localPresence.worldId, scope.worldId),
        eq(localPresence.npcId, scope.npcId),
        eq(localPresence.contextId, scope.contextId),
        eq(localPresence.id, scope.presenceId),
      ),
    )
    .for("share");
  if (
    world?.status !== "active" ||
    context?.status !== "active" ||
    context.type !== "scene" ||
    context.policy !== "mapped_players" ||
    !context.locationId ||
    entity?.status !== "active" ||
    entity.type !== "npc" ||
    npc?.lifecycle !== "active" ||
    !state ||
    state.locationCertainty !== "certain" ||
    state.currentLocationId !== context.locationId ||
    !presence ||
    presence.revokedAt ||
    presence.locationId !== context.locationId ||
    presence.stateVersion !== state.version
  )
    return null;
  return state;
}

// This is a host-only, offline, transactionally checked repository.
// NEVER expose it through Discord events, an HTTP endpoint, or a public CLI.
// An actual DM membership/authentication registry is not yet implemented.
export async function issueHostSceneSpeechPolicy(db: Database, raw: unknown) {
  const parsed = issueSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid_request" as const };
  const { issuerEntityId, ttlMinutes, ...input } = parsed.data;
  const scope: Scope = {
    worldId: input.worldId,
    npcId: input.npcId,
    contextId: input.contextId,
    presenceId: input.presenceId,
  };
  return db.transaction(async (tx) => {
    if (!(await authorizedHost(tx)))
      return { status: "operator_only" as const };
    await lockLocalContext(tx, scope);
    const state = await validScene(tx, scope);
    if (!state) return { status: "scene_denied" as const };

    const [issuer] = await tx
      .select({ status: entities.status })
      .from(entities)
      .where(
        and(
          eq(entities.worldId, scope.worldId),
          eq(entities.id, issuerEntityId),
        ),
      )
      .for("share");
    if (issuer?.status !== "active")
      return { status: "issuer_not_found" as const };

    const existing = await tx
      .select({ id: sceneSpeechPolicies.id })
      .from(sceneSpeechPolicies)
      .where(
        and(
          eq(sceneSpeechPolicies.worldId, scope.worldId),
          eq(sceneSpeechPolicies.npcId, scope.npcId),
          eq(sceneSpeechPolicies.contextId, scope.contextId),
          isNull(sceneSpeechPolicies.revokedAt),
        ),
      )
      .limit(1);
    if (existing.length) return { status: "already_open" as const };

    const [record] = await tx
      .insert(sceneSpeechPolicies)
      .values({
        id: randomUUID(),
        ...scope,
        npcStateVersion: state.version,
        issuerEntityId,
        issuerRole: "host_operator",
        decision: input.decision,
        activity: input.activity,
        perception: input.perception,
        otherScene: input.otherScene,
        expiresAt: sql`clock_timestamp() + ${ttlMinutes}::integer * interval '1 minute'`,
      })
      .returning({ id: sceneSpeechPolicies.id });
    if (!record) throw Error("Scene policy persistence failed");
    return { status: "created" as const, id: record.id };
  });
}

export async function readTrustedHostScenePolicy(
  db: Database,
  raw: unknown,
): Promise<TrustedSceneSpeechApproval | null> {
  const parsed = scopeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const scope = parsed.data;
  return db.transaction(async (tx) => {
    if (!(await authorizedHost(tx))) return null;
    await lockLocalContext(tx, scope);
    const state = await validScene(tx, scope);
    if (!state) return null;
    const matches = await tx
      .select()
      .from(sceneSpeechPolicies)
      .where(
        and(
          whereScope(scope),
          isNull(sceneSpeechPolicies.revokedAt),
          sql`${sceneSpeechPolicies.expiresAt} > clock_timestamp()`,
        ),
      )
      .limit(2);
    if (matches.length !== 1) return null;
    const policy = matches[0]!;
    if (
      policy.npcStateVersion !== state.version ||
      policy.issuerRole !== "host_operator" ||
      ![...allowedDatabases.values()].includes(policy.issuedBy)
    )
      return null;
    const [issuer] = await tx
      .select({ status: entities.status })
      .from(entities)
      .where(
        and(
          eq(entities.worldId, scope.worldId),
          eq(entities.id, policy.issuerEntityId),
        ),
      )
      .for("share");
    if (issuer?.status !== "active") return null;
    return {
      id: policy.id,
      ...scope,
      npcStateVersion: state.version,
      issuedByEntityId: policy.issuerEntityId,
      issuedByRole: "host_operator" as const,
      decision: policy.decision as TrustedSceneSpeechApproval["decision"],
      activity: policy.activity as TrustedSceneSpeechApproval["activity"],
      perception: policy.perception as TrustedSceneSpeechApproval["perception"],
      otherScene: policy.otherScene as TrustedSceneSpeechApproval["otherScene"],
      issuedAt: policy.issuedAt,
      expiresAt: policy.expiresAt,
      revokedAt: policy.revokedAt,
    };
  });
}

export async function revokeHostSceneSpeechPolicy(
  db: Database,
  raw: unknown,
) {
  const parsed = scopeSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid_request" as const };
  const scope = parsed.data;
  return db.transaction(async (tx) => {
    if (!(await authorizedHost(tx)))
      return { status: "operator_only" as const };
    await lockLocalContext(tx, scope);
    const [current] = await tx
      .select()
      .from(sceneSpeechPolicies)
      .where(whereScope(scope))
      .orderBy(sql`${sceneSpeechPolicies.issuedAt} desc`)
      .limit(1)
      .for("update");
    if (!current) return { status: "not_found" as const };
    if (current.revokedAt)
      return { status: "already_revoked" as const };
    await tx
      .update(sceneSpeechPolicies)
      .set({
        revokedAt: sql`clock_timestamp()`,
        revokedBy: sql`current_user`,
      })
      .where(eq(sceneSpeechPolicies.id, current.id));
    return { status: "revoked" as const };
  });
}
