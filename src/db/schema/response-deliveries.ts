import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { interactions } from "./interactions.js";
import type { DeliveryPayload } from "../../delivery/contracts.js";
export const responseDeliveries = pgTable(
  "npc_response_deliveries",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id").notNull(),
    npcId: uuid("npc_id").notNull(),
    contextId: uuid("context_id").notNull(),
    interactionId: uuid("interaction_id").notNull(),
    payload: jsonb("payload").$type<DeliveryPayload>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status", {
      enum: [
        "pending",
        "claimed",
        "sending",
        "delivered",
        "retryable",
        "uncertain",
        "blocked",
        "failed",
      ],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    attemptId: uuid("attempt_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ackMessageId: text("ack_message_id"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastCode: text("last_code"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconciledBy: text("reconciled_by"),
    reconciliationEvidence: text("reconciliation_evidence"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("response_delivery_interaction_unique").on(t.interactionId),
    foreignKey({
      name: "response_delivery_scope_fk",
      columns: [t.worldId, t.npcId, t.contextId, t.interactionId],
      foreignColumns: [
        interactions.worldId,
        interactions.npcId,
        interactions.contextId,
        interactions.id,
      ],
    }).onDelete("restrict"),
    check(
      "response_delivery_status",
      sql`${t.status} in ('pending','claimed','sending','delivered','retryable','uncertain','blocked','failed')`,
    ),
    check("response_delivery_attempts", sql`${t.attempts} between 0 and 3`),
    check(
      "response_delivery_claim_shape",
      sql`(${t.attempts}=0 and ${t.attemptId} is null and ${t.leaseUntil} is null) or (${t.attempts}>0 and ${t.attemptId} is not null and ${t.leaseUntil} is not null)`,
    ),
    check(
      "response_delivery_dispatch_shape",
      sql`${t.status} not in ('sending','uncertain','delivered') or ${t.dispatchedAt} is not null`,
    ),
    check(
      "response_delivery_ack_shape",
      sql`(${t.status}='delivered' and ${t.ackMessageId} is not null and ${t.deliveredAt} is not null) or (${t.status}<>'delivered' and ${t.ackMessageId} is null and ${t.deliveredAt} is null)`,
    ),
    index("response_delivery_world_status_idx").on(t.worldId, t.status),
  ],
);
