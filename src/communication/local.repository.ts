import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import {
  worlds,
  entities,
  npcs,
  npcState,
  interactionContexts,
  interactions,
  localPresence,
} from "../db/schema/index.js";
import { evaluateLocal, type LocalEligibility } from "./eligibility.js";

type Database = Omit<DatabaseClient["db"], "$client">;
const scopeSchema = z
  .object({
    worldId: z.string().uuid(),
    npcId: z.string().uuid(),
    contextId: z.string().uuid(),
  })
  .strict();
type Scope = z.infer<typeof scopeSchema>;
const evidenceWhere = (s: Scope, id: string) =>
  and(
    eq(localPresence.worldId, s.worldId),
    eq(localPresence.npcId, s.npcId),
    eq(localPresence.contextId, s.contextId),
    eq(localPresence.id, id),
  );

// Shared with response fences. Context precedes interaction, matching strict intake.
export async function lockLocalContext(tx: Database, s: Scope) {
  await tx.execute(sql`set local lock_timeout='2s'`);
  await tx.execute(sql`set local statement_timeout='5s'`);
  await tx.execute(sql`select id from worlds where id=${s.worldId} for share`);
  await tx.execute(
    sql`select id from interaction_contexts where world_id=${s.worldId} and id=${s.contextId} for share`,
  );
}
async function facts(tx: Database, s: Scope) {
  await tx.execute(
    sql`select id from entities where world_id=${s.worldId} and id=${s.npcId} for share`,
  );
  await tx.execute(
    sql`select entity_id from npcs where entity_id=${s.npcId} for share`,
  );
  await tx.execute(
    sql`select npc_id from npc_state where npc_id=${s.npcId} for share`,
  );
  const [row] = await tx
    .select({
      worldStatus: worlds.status,
      entityStatus: entities.status,
      entityType: entities.entityType,
      lifecycle: npcs.lifecycleState,
      contextStatus: interactionContexts.status,
      contextType: interactionContexts.contextType,
      locationId: interactionContexts.linkedLocationEntityId,
      currentLocationId: npcState.currentLocationId,
      certainty: npcState.locationCertainty,
      stateVersion: npcState.version,
      policy: interactionContexts.npcIntakePolicy,
    })
    .from(worlds)
    .innerJoin(
      entities,
      and(eq(entities.worldId, worlds.id), eq(entities.id, s.npcId)),
    )
    .innerJoin(npcs, eq(npcs.entityId, entities.id))
    .innerJoin(npcState, eq(npcState.npcId, npcs.entityId))
    .innerJoin(
      interactionContexts,
      and(
        eq(interactionContexts.worldId, worlds.id),
        eq(interactionContexts.id, s.contextId),
      ),
    )
    .where(eq(worlds.id, s.worldId));
  return (
    row && {
      ...row,
      active:
        row.worldStatus === "active" &&
        row.entityStatus === "active" &&
        row.entityType === "npc" &&
        row.lifecycle === "active" &&
        row.contextStatus === "active",
      scene: row.contextType === "scene",
      certain: row.certainty === "certain",
    }
  );
}
// Trusted local operator boundary: authority is host access + DB credentials.
// Never expose these functions through Discord/HTTP or accept asserted operator IDs.
export async function grantLocalPresence(database: Database, input: Scope) {
  const s = scopeSchema.parse(input);
  return database.transaction(async (tx) => {
    await lockLocalContext(tx, s);
    const f = await facts(tx, s);
    const result = evaluateLocal(
      f,
      f?.locationId
        ? {
            locationId: f.locationId,
            stateVersion: f.stateVersion,
            issuedAt: new Date(0),
            revokedAt: null,
          }
        : undefined,
    );
    if (result.status !== "eligible_local" || !f?.locationId) return result;
    const [evidence] = await tx
      .insert(localPresence)
      .values({
        id: randomUUID(),
        ...s,
        locationId: f.locationId,
        stateVersion: f.stateVersion,
      })
      .returning();
    return { status: "granted" as const, evidence: evidence! };
  });
}
export async function revokeLocalPresence(
  database: Database,
  input: Scope,
  evidenceId: string,
) {
  const s = scopeSchema.parse(input);
  z.string().uuid().parse(evidenceId);
  return database.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout='2s'`);
    await tx.execute(sql`set local statement_timeout='5s'`);
    const [evidence] = await tx
      .select()
      .from(localPresence)
      .where(evidenceWhere(s, evidenceId))
      .for("update");
    if (!evidence) return { status: "not_found" as const };
    if (evidence.revokedAt) return { status: "already_revoked" as const };
    await tx
      .update(localPresence)
      .set({ revokedAt: sql`clock_timestamp()`, revokedBy: sql`current_user` })
      .where(evidenceWhere(s, evidenceId));
    return { status: "revoked" as const };
  });
}
export async function validateLocalInteraction(
  tx: Database,
  row: typeof interactions.$inferSelect,
): Promise<LocalEligibility> {
  const s = {
    worldId: row.worldId,
    npcId: row.npcId,
    contextId: row.contextId,
  };
  const f = await facts(tx, s);
  if (row.sourceProvider === "discord" && f?.policy !== "mapped_players")
    return { status: "blocked", reason: "policy_disabled" };
  const [evidence] = row.localPresenceId
    ? await tx
        .select()
        .from(localPresence)
        .where(evidenceWhere(s, row.localPresenceId))
        .for("share")
    : [];
  const result = evaluateLocal(
    f,
    evidence,
    row.createdAt,
    row.communicationMode,
  );
  if (result.status !== "eligible_local" || !evidence) return result;
  // PostgreSQL retains microseconds; JS Date does not. Enforce the receipt
  // window in the database as well, including events in the same millisecond.
  const [window] = await tx
    .select({
      valid: sql<boolean>`${localPresence.issuedAt} <= (select created_at from interactions where id=${row.id})`,
    })
    .from(localPresence)
    .where(evidenceWhere(s, evidence.id));
  return window?.valid ? result : { status: "blocked", reason: "stale" };
}
export async function prepareLocalInteraction(
  database: Database,
  input: Scope & { interactionId: string; evidenceId: string },
) {
  const { interactionId, evidenceId, ...scope } = input;
  const s = scopeSchema.parse(scope);
  z.string().uuid().parse(interactionId);
  z.string().uuid().parse(evidenceId);
  return database.transaction(async (tx) => {
    await lockLocalContext(tx, s);
    const [row] = await tx
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.worldId, s.worldId),
          eq(interactions.npcId, s.npcId),
          eq(interactions.contextId, s.contextId),
          eq(interactions.id, interactionId),
        ),
      )
      .for("update");
    if (!row) return { status: "blocked" as const, reason: "missing" as const };
    if (
      row.status !== "received" ||
      row.responseText !== null ||
      row.responseClaimId !== null
    )
      return { status: "conflict" as const };
    if (row.communicationMode === "local" && row.localPresenceId !== evidenceId)
      return { status: "conflict" as const };
    if (
      row.communicationMode !== "unknown" &&
      row.communicationMode !== "local"
    )
      return {
        status: "blocked" as const,
        reason: "unsupported_remote" as const,
      };
    const result = await validateLocalInteraction(tx, {
      ...row,
      localPresenceId: evidenceId,
    });
    if (result.status !== "eligible_local") return result;
    if (row.communicationMode === "local")
      return { status: "already_prepared" as const, interaction: row };
    const [prepared] = await tx
      .update(interactions)
      .set({ communicationMode: "local", localPresenceId: evidenceId })
      .where(eq(interactions.id, row.id))
      .returning();
    return { status: "prepared" as const, interaction: prepared! };
  });
}
