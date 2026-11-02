import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import {
  interactions,
  responseDeliveries,
  discordContextMappings,
  worlds,
  entities,
} from "../db/schema/index.js";
import { lockRouting } from "../domains/discord-mapping/discord-mapping.repository.js";
import {
  lockLocalContext,
  validateLocalInteraction,
} from "../communication/local.repository.js";
import { resolveOriginalRoute } from "./routing.js";
import {
  acknowledgementSchema,
  fingerprint,
  LEASE_MS,
  MAX_ATTEMPTS,
  payloadSchema,
  retryDelay,
  scopeSchema,
  type DeliveryAcknowledgement,
  type DeliveryPayload,
  type DeliveryScope,
} from "./contracts.js";

type Database = Omit<DatabaseClient["db"], "$client">;
export type DeliveryRow = typeof responseDeliveries.$inferSelect;
type Interaction = typeof interactions.$inferSelect;
export interface DeliveryOptions {
  clock?: () => Date;
  avatars?: ReadonlyMap<string, string>;
}
const interactionWhere = (s: DeliveryScope) =>
  and(
    eq(interactions.worldId, s.worldId),
    eq(interactions.npcId, s.npcId),
    eq(interactions.id, s.interactionId),
  );
const outboxWhere = (s: DeliveryScope) =>
  and(
    eq(responseDeliveries.worldId, s.worldId),
    eq(responseDeliveries.npcId, s.npcId),
    eq(responseDeliveries.interactionId, s.interactionId),
  );
type Locked = {
  row: Interaction;
  delivery: DeliveryRow | undefined;
  routeValid: boolean;
};
type Plan =
  | { ok: true; payload: DeliveryPayload; hash: string }
  | { ok: false; reason: string };
export function createDeliveryRepository(
  database: Database,
  options: DeliveryOptions = {},
) {
  const clock = options.clock ?? (() => new Date());
  async function within<T>(
    input: DeliveryScope,
    work: (tx: Database, l: Locked) => Promise<T>,
  ): Promise<T | null> {
    const s = scopeSchema.parse(input);
    return database.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout='2s'`);
      await tx.execute(sql`set local statement_timeout='5s'`);
      const [snapshot] = await tx
        .select()
        .from(interactions)
        .where(interactionWhere(s));
      if (!snapshot) return null;
      let routeValid = false;
      if (
        snapshot.sourceGuildId &&
        snapshot.sourceChannelId &&
        snapshot.sourceMappingId
      ) {
        await lockRouting(tx, [
          "location",
          snapshot.sourceGuildId,
          snapshot.sourceChannelId,
        ]);
        const routes = await tx
          .select()
          .from(discordContextMappings)
          .where(
            and(
              eq(discordContextMappings.guildId, snapshot.sourceGuildId),
              eq(discordContextMappings.channelId, snapshot.sourceChannelId),
            ),
          )
          .orderBy(discordContextMappings.id)
          .for("share");
        const ids = [...new Set(routes.map((r) => r.worldId))].sort();
        const activeWorlds = ids.length
          ? await tx
              .select()
              .from(worlds)
              .where(inArray(worlds.id, ids))
              .orderBy(worlds.id)
              .for("share")
          : [];
        routeValid = resolveOriginalRoute(
          s,
          snapshot.contextId,
          {
            guildId: snapshot.sourceGuildId,
            channelId: snapshot.sourceChannelId,
            threadId: snapshot.sourceThreadId,
            mappingId: snapshot.sourceMappingId,
          },
          routes.map((r) => ({
            ...r,
            worldActive: activeWorlds.some(
              (w) => w.id === r.worldId && w.status === "active",
            ),
          })),
        );
      }
      await lockLocalContext(tx, snapshot);
      const [row] = await tx
        .select()
        .from(interactions)
        .where(interactionWhere(s))
        .for("update");
      if (!row) return null;
      const [delivery] = await tx
        .select()
        .from(responseDeliveries)
        .where(outboxWhere(s))
        .for("update");
      return work(tx, { row, delivery, routeValid });
    });
  }
  async function plan(tx: Database, l: Locked): Promise<Plan> {
    const { row } = l;
    if (!l.routeValid) return { ok: false, reason: "route_untrusted" };
    if (
      row.sourceProvider !== "discord" ||
      row.communicationMode !== "local" ||
      !row.responseText ||
      !["responded", "completed"].includes(row.status) ||
      row.responseGenerationOutcome !== "responded"
    )
      return { ok: false, reason: "response_unavailable" };
    const eligibility = await validateLocalInteraction(tx, row);
    if (eligibility.status !== "eligible_local")
      return { ok: false, reason: eligibility.reason };
    const [npc] = await tx
      .select()
      .from(entities)
      .where(
        and(eq(entities.worldId, row.worldId), eq(entities.id, row.npcId)),
      );
    const parsed = payloadSchema.safeParse({
      scope: { worldId: row.worldId, npcId: row.npcId, interactionId: row.id },
      destination: {
        provider: "discord",
        guildId: row.sourceGuildId,
        channelId: row.sourceChannelId,
        threadId: row.sourceThreadId,
      },
      replyToMessageId: row.sourceMessageId,
      identity: {
        displayName: npc?.canonicalName,
        avatarUrl: options.avatars?.get(`${row.worldId}:${row.npcId}`) ?? null,
      },
      content: row.responseText,
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
    });
    if (!parsed.success) return { ok: false, reason: "unsafe_payload" };
    const hash = fingerprint(parsed.data);
    if (
      l.delivery &&
      (hash !== l.delivery.fingerprint ||
        !isDeepStrictEqual(
          parsed.data,
          payloadSchema.safeParse(l.delivery.payload).data,
        ))
    )
      return { ok: false, reason: "snapshot_changed" };
    return { ok: true, payload: parsed.data, hash };
  }
  async function update(
    tx: Database,
    row: DeliveryRow,
    values: Partial<DeliveryRow>,
  ) {
    return (
      await tx
        .update(responseDeliveries)
        .set(values)
        .where(eq(responseDeliveries.id, row.id))
        .returning()
    )[0]!;
  }
  async function expire(tx: Database, d: DeliveryRow, now: Date) {
    if (
      (d.status === "claimed" || d.status === "sending") &&
      d.leaseUntil! <= now
    )
      return update(tx, d, {
        status:
          d.status === "sending"
            ? "uncertain"
            : d.attempts >= MAX_ATTEMPTS
              ? "failed"
              : "retryable",
        lastCode:
          d.status === "sending"
            ? "lease_after_dispatch"
            : "lease_before_dispatch",
        nextAttemptAt: new Date(now.getTime() + retryDelay(d.attempts, 0)),
      });
    return d;
  }
  async function saveAck(
    tx: Database,
    l: Locked,
    d: DeliveryRow,
    ack: DeliveryAcknowledgement,
    now: Date,
    audit: Partial<DeliveryRow> = {},
  ) {
    if (
      ack.attemptId !== d.attemptId ||
      ack.fingerprint !== d.fingerprint ||
      !isDeepStrictEqual(ack.destination, d.payload.destination) ||
      ack.messageId === l.row.sourceMessageId ||
      (l.row.responseMessageId !== null &&
        l.row.responseMessageId !== ack.messageId)
    )
      return false;
    if (d.status === "delivered") return d.ackMessageId === ack.messageId;
    await update(tx, d, {
      status: "delivered",
      ackMessageId: ack.messageId,
      deliveredAt: now,
      lastCode: "acknowledged",
      ...audit,
    });
    await tx
      .update(interactions)
      .set({ responseMessageId: ack.messageId })
      .where(interactionWhere(ackScope(l.row)));
    return true;
  }
  return {
    // Non-mutating authorization preview for the isolated operator boundary.
    // Existing lock order is reused; no outbox/interaction/evidence writes occur.
    async preview(s: DeliveryScope) {
      return (
        (await within(s, async (tx, l) => {
          const p = await plan(tx, l);
          if (!p.ok) return { status: "blocked" as const, reason: p.reason };
          return {
            status: "ready" as const,
            payload: p.payload,
            fingerprint: p.hash,
            deliveryStatus: l.delivery?.status ?? null,
          };
        })) ?? { status: "blocked" as const, reason: "not_found" }
      );
    },
    async prepare(s: DeliveryScope) {
      return (
        (await within(s, async (tx, l) => {
          if (l.delivery) {
            if (["pending", "retryable"].includes(l.delivery.status)) {
              const p = await plan(tx, l);
              if (!p.ok) {
                await update(tx, l.delivery, {
                  status: "blocked",
                  lastCode: p.reason,
                });
                return { status: "blocked" as const, reason: p.reason };
              }
            }
            return { status: "existing" as const, delivery: l.delivery };
          }
          if (l.row.responseMessageId)
            return { status: "blocked" as const, reason: "already_referenced" };
          const p = await plan(tx, l);
          if (!p.ok) return { status: "blocked" as const, reason: p.reason };
          const [delivery] = await tx
            .insert(responseDeliveries)
            .values({
              id: randomUUID(),
              worldId: s.worldId,
              npcId: s.npcId,
              contextId: l.row.contextId,
              interactionId: s.interactionId,
              payload: p.payload,
              fingerprint: p.hash,
              nextAttemptAt: clock(),
            })
            .returning();
          return { status: "prepared" as const, delivery: delivery! };
        })) ?? { status: "blocked" as const, reason: "not_found" }
      );
    },
    async claim(s: DeliveryScope) {
      return within(s, async (tx, l) => {
        if (!l.delivery) return null;
        const now = clock(),
          d = await expire(tx, l.delivery, now);
        if (
          !["pending", "retryable"].includes(d.status) ||
          d.nextAttemptAt > now ||
          d.attempts >= MAX_ATTEMPTS
        )
          return null;
        const p = await plan(tx, l);
        if (!p.ok) {
          await update(tx, d, { status: "blocked", lastCode: p.reason });
          return null;
        }
        if (l.row.responseMessageId) {
          await update(tx, d, {
            status: "blocked",
            lastCode: "already_referenced",
          });
          return null;
        }
        return update(tx, d, {
          status: "claimed",
          attemptId: randomUUID(),
          attempts: d.attempts + 1,
          leaseUntil: new Date(now.getTime() + LEASE_MS),
          dispatchedAt: null,
          lastCode: "claimed",
        });
      });
    },
    async preflight(s: DeliveryScope, attemptId: string) {
      z.string().uuid().parse(attemptId);
      return within(s, async (tx, l) => {
        if (!l.delivery) return null;
        const d = await expire(tx, l.delivery, clock());
        if (d.status !== "claimed" || d.attemptId !== attemptId) return null;
        const p = await plan(tx, l);
        if (!p.ok) {
          await update(tx, d, { status: "blocked", lastCode: p.reason });
          return null;
        }
        return update(tx, d, {
          status: "sending",
          dispatchedAt: clock(),
          lastCode: "possibly_sending",
        });
      });
    },
    async acknowledge(s: DeliveryScope, input: DeliveryAcknowledgement) {
      const parsed = acknowledgementSchema.safeParse(input);
      if (!parsed.success) return false;
      return (
        (await within(s, async (tx, l) => {
          if (!l.delivery) return false;
          const d = await expire(tx, l.delivery, clock());
          if (d.status !== "delivered" && d.status !== "sending") return false;
          return saveAck(tx, l, d, parsed.data, clock());
        })) ?? false
      );
    },
    async fail(
      s: DeliveryScope,
      attemptId: string,
      outcome:
        | { kind: "uncertain" }
        | { kind: "not_sent"; retryable: boolean; retryAfterMs: number },
    ) {
      return within(s, async (tx, l) => {
        if (!l.delivery) return null;
        const now = clock(),
          d = await expire(tx, l.delivery, now);
        if (d.status !== "sending" || d.attemptId !== attemptId) return d;
        if (outcome.kind === "uncertain")
          return update(tx, d, {
            status: "uncertain",
            lastCode: "transport_ambiguous",
          });
        const delay = z
          .number()
          .int()
          .min(0)
          .max(86_400_000)
          .parse(outcome.retryAfterMs);
        return update(tx, d, {
          status:
            outcome.retryable && d.attempts < MAX_ATTEMPTS
              ? "retryable"
              : "failed",
          lastCode: "confirmed_not_sent",
          nextAttemptAt: new Date(
            now.getTime() + retryDelay(d.attempts, delay),
          ),
        });
      });
    },
    async recover(s: DeliveryScope) {
      return within(s, async (tx, l) =>
        l.delivery ? expire(tx, l.delivery, clock()) : null,
      );
    },
    // Trusted local operator/DB boundary, never a player-supplied assertion.
    async reconcile(
      s: DeliveryScope,
      attemptId: string,
      decision:
        | { kind: "delivered"; ack: DeliveryAcknowledgement; evidence: string }
        | { kind: "not_sent"; evidence: string },
    ) {
      z.string().uuid().parse(attemptId);
      const proof = z
        .string()
        .min(1)
        .max(200)
        .regex(/^[A-Za-z0-9:._-]+$/u)
        .parse(decision.evidence);
      return (
        (await within(s, async (tx, l) => {
          if (!l.delivery) return false;
          const d = await expire(tx, l.delivery, clock());
          if (d.status !== "uncertain" || d.attemptId !== attemptId)
            return false;
          const [operator] = await tx
            .select({ role: sql<string>`current_user` })
            .from(worlds)
            .where(eq(worlds.id, s.worldId));
          const audit = {
            reconciledAt: clock(),
            reconciledBy: operator!.role,
            reconciliationEvidence: proof,
          };
          if (decision.kind === "delivered") {
            const parsed = acknowledgementSchema.safeParse(decision.ack);
            if (
              !parsed.success ||
              !(await saveAck(tx, l, d, parsed.data, clock(), audit))
            )
              return false;
          } else
            await update(tx, d, {
              status: d.attempts >= MAX_ATTEMPTS ? "failed" : "retryable",
              lastCode: "operator_verified_not_sent",
              ...audit,
              nextAttemptAt: new Date(
                clock().getTime() + retryDelay(d.attempts, 0),
              ),
            });
          return true;
        })) ?? false
      );
    },
  };
}
const ackScope = (row: Interaction): DeliveryScope => ({
  worldId: row.worldId,
  npcId: row.npcId,
  interactionId: row.id,
});
export type DeliveryRepository = ReturnType<typeof createDeliveryRepository>;
