import { isDeepStrictEqual } from "node:util";
import { createContextBuilder } from "../context/context-builder.js";
import { createContextReader } from "../context/context.repository.js";
import type {
  Interaction,
  NpcContextBundle,
} from "../context/context.types.js";
import { filterResponseContext, VisibilityBlocked } from "./visibility.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../db/client.js";
import { interactions } from "../db/schema/interactions.js";
import {
  markInteractionProcessing,
  recordInteractionResponse,
  failInteraction,
} from "../domains/interaction/interaction.repository.js";
import {
  CLAIM_LEASE_MS,
  PROMPT_VERSION,
  type ResponseScope,
  type ResponseStore,
} from "./contracts.js";

type Database = Omit<DatabaseClient["db"], "$client">;
const scopeWhere = (s: ResponseScope) =>
  and(
    eq(interactions.worldId, s.worldId),
    eq(interactions.npcId, s.npcId),
    eq(interactions.id, s.interactionId),
  );
const unexpired = sql`${interactions.responseClaimedAt} + ${CLAIM_LEASE_MS} * interval '1 millisecond' > clock_timestamp()`;
export function createResponseStore(database: Database): ResponseStore {
  const locked = async (tx: Database, scope: ResponseScope) =>
    (
      await tx
        .select()
        .from(interactions)
        .where(scopeWhere(scope))
        .for("update")
    )[0];
  // Lock only for the local eligibility check and lifecycle write. These locks
  // are released before generation (including token counting/budget reservation).
  const eligible = async (
    tx: Database,
    row: Interaction,
    expected?: NpcContextBundle,
  ) => {
    await tx.execute(
      sql`select id from worlds where id=${row.worldId} for share`,
    );
    await tx.execute(sql`select id from entities where world_id=${row.worldId}
      and (id=${row.npcId} or id=${row.speakerEntityId}) order by id for share`);
    await tx.execute(
      sql`select entity_id from npcs where entity_id=${row.npcId} for share`,
    );
    await tx.execute(
      sql`select npc_id from npc_state where npc_id=${row.npcId} for share`,
    );
    await tx.execute(
      sql`select npc_id from npc_game_profiles where npc_id=${row.npcId} for share`,
    );
    await tx.execute(sql`select id from interaction_contexts where world_id=${row.worldId}
      and id=${row.contextId} for share`);
    try {
      const fresh = await createContextBuilder(createContextReader(tx))({
        worldId: row.worldId,
        npcId: row.npcId,
        interactionId: row.id,
        limits: { history: 0 },
      });
      const permitted = filterResponseContext(fresh, row);
      // All retrieved knowledge is withheld, so its access changes cannot
      // authorize prompt content. Compare every remaining prompt-visible field.
      return (
        !expected ||
        (isDeepStrictEqual(fresh.current.context, expected.current.context) &&
          fresh.npc.state?.currentLocationId ===
            expected.npc.state?.currentLocationId &&
          fresh.npc.state?.locationCertainty ===
            expected.npc.state?.locationCertainty &&
          isDeepStrictEqual(
            permitted.sections,
            filterResponseContext(expected, row).sections,
          ))
      );
    } catch (error) {
      if (error instanceof VisibilityBlocked) return false;
      throw error;
    }
  };
  return {
    claim: (scope, expected, context) =>
      database.transaction(async (tx) => {
        const row = await locked(tx, scope);
        if (
          !row ||
          expected.worldId !== scope.worldId ||
          expected.npcId !== scope.npcId ||
          expected.id !== scope.interactionId ||
          row.status !== "received" ||
          row.responseText !== null ||
          row.responseClaimId !== null ||
          row.contextId !== expected.contextId ||
          row.speakerEntityId !== expected.speakerEntityId ||
          row.requestText !== expected.requestText ||
          row.communicationMode !== expected.communicationMode ||
          row.traceId !== expected.traceId ||
          row.createdAt.getTime() !== expected.createdAt.getTime()
        )
          return null;
        if (!(await eligible(tx, row, context))) return null;
        const updated = await markInteractionProcessing(
          tx,
          scope.worldId,
          scope.npcId,
          scope.interactionId,
        );
        if (!updated) return null;
        const [claimed] = await tx
          .update(interactions)
          .set({
            responseClaimId: randomUUID(),
            responseClaimedAt: sql`clock_timestamp()`,
            responsePromptVersion: PROMPT_VERSION,
            responseGenerationOutcome: "claimed",
          })
          .where(and(scopeWhere(scope), isNull(interactions.responseClaimId)))
          .returning();
        if (!claimed) throw new Error("Response claim changed.");
        return claimed;
      }),
    dispatch: (scope, claimId, context) =>
      database.transaction(async (tx) => {
        const row = await locked(tx, scope);
        if (
          !row ||
          row.responseClaimId !== claimId ||
          row.responseGenerationOutcome !== "claimed" ||
          !(await eligible(tx, row, context))
        )
          return false;
        const rows = await tx
          .update(interactions)
          .set({
            responseDispatchedAt: sql`clock_timestamp()`,
            responseGenerationOutcome: "dispatched",
          })
          .where(
            and(
              scopeWhere(scope),
              eq(interactions.status, "processing"),
              eq(interactions.responseClaimId, claimId),
              eq(interactions.responseGenerationOutcome, "claimed"),
              isNull(interactions.responseText),
              unexpired,
            ),
          )
          .returning({ id: interactions.id });
        return rows.length === 1;
      }),
    validate: (scope, claimId, context) =>
      database.transaction(async (tx) => {
        const row = await locked(tx, scope);
        if (
          !row ||
          row.status !== "processing" ||
          row.responseText !== null ||
          row.responseClaimId !== claimId ||
          row.responseGenerationOutcome !== "dispatched"
        )
          return false;
        if (!(await eligible(tx, row, context))) return false;
        const [live] = await tx
          .select({ id: interactions.id })
          .from(interactions)
          .where(and(scopeWhere(scope), unexpired));
        return !!live;
      }),
    persist: (scope, claimId, text, context) =>
      database.transaction(async (tx) => {
        const row = await locked(tx, scope);
        if (
          !row ||
          row.status !== "processing" ||
          row.responseText !== null ||
          row.responseClaimId !== claimId ||
          row.responseGenerationOutcome !== "dispatched"
        )
          return null;
        const [live] = await tx
          .select({ id: interactions.id })
          .from(interactions)
          .where(and(scopeWhere(scope), unexpired));
        if (!live || !(await eligible(tx, row, context))) return null;
        const [stillLive] = await tx
          .select({ id: interactions.id })
          .from(interactions)
          .where(and(scopeWhere(scope), unexpired));
        if (!stillLive) return null;
        const saved = await recordInteractionResponse(
          tx,
          scope.worldId,
          scope.npcId,
          scope.interactionId,
          { responseText: text },
        );
        if (!saved)
          throw new Error(
            "Response persistence did not return an interaction.",
          );
        const [updated] = await tx
          .update(interactions)
          .set({ responseGenerationOutcome: "responded" })
          .where(scopeWhere(scope))
          .returning();
        return updated;
      }),
    fail: async (scope, claimId, uncertain) => {
      await database.transaction(async (tx) => {
        const row = await locked(tx, scope);
        if (
          !row ||
          row.responseClaimId !== claimId ||
          row.responseText !== null ||
          row.status !== "processing" ||
          !["claimed", "dispatched"].includes(
            row.responseGenerationOutcome ?? "",
          )
        )
          return;
        await failInteraction(
          tx,
          scope.worldId,
          scope.npcId,
          scope.interactionId,
        );
        await tx
          .update(interactions)
          .set({
            responseGenerationOutcome:
              uncertain && row.responseDispatchedAt ? "uncertain" : "failed",
          })
          .where(scopeWhere(scope));
      });
    },
    reconcile: (scope) =>
      database.transaction(async (tx) => {
        const row = await locked(tx, scope);
        if (!row) return "not_found";
        if (
          row.responseText !== null &&
          ["responded", "completed"].includes(row.status)
        )
          return "responded";
        if (!row.responseClaimId) return "not_claimed";
        if (row.status !== "processing") return "terminal";
        const [live] = await tx
          .select({ id: interactions.id })
          .from(interactions)
          .where(and(scopeWhere(scope), unexpired));
        if (live) return "active";
        await failInteraction(
          tx,
          scope.worldId,
          scope.npcId,
          scope.interactionId,
        );
        const uncertain = row.responseDispatchedAt !== null;
        await tx
          .update(interactions)
          .set({
            responseGenerationOutcome: uncertain ? "uncertain" : "failed",
          })
          .where(scopeWhere(scope));
        return uncertain ? "reconciled_uncertain" : "reconciled_failed";
      }),
  };
}
