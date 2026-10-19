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
  return {
    claim: (scope, expected) =>
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
    dispatch: async (scope, claimId) => {
      const rows = await database
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
    },
    persist: (scope, claimId, text) =>
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
        if (!live) return null;
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
