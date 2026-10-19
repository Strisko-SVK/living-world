import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  bigint,
  integer,
  timestamp,
  uuid,
  check,
  index,
} from "drizzle-orm/pg-core";

export const llmBudget = pgTable(
  "llm_budget",
  {
    id: text("id").primaryKey(),
    currency: text("currency").notNull(),
    ceiling: bigint("ceiling_micros", { mode: "bigint" }).notNull(),
  },
  (t) => [
    check("llm_budget_singleton", sql`${t.id} = 'llm'`),
    check("llm_budget_currency", sql`${t.currency} in ('USD', 'EUR')`),
    check("llm_budget_positive", sql`${t.ceiling} > 0`),
  ],
);
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey(),
    traceId: uuid("trace_id").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => llmBudget.id),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    reserved: bigint("reserved_micros", { mode: "bigint" }).notNull(),
    charged: bigint("charged_micros", { mode: "bigint" }).notNull(),
    inputRate: bigint("input_rate", { mode: "bigint" }).notNull(),
    outputRate: bigint("output_rate", { mode: "bigint" }).notNull(),
    status: text("status").notNull(),
    outcome: text("outcome").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    retries: integer("retries").notNull().default(0),
    latencyMs: integer("latency_ms"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "llm_usage_amounts",
      sql`${t.reserved} > 0 and ${t.charged} >= 0 and ${t.inputRate} > 0 and ${t.outputRate} > 0`,
    ),
    check(
      "llm_usage_status",
      sql`${t.status} in ('reserved', 'settled', 'uncertain')`,
    ),
    check(
      "llm_usage_lifecycle",
      sql`(${t.status} = 'reserved' and ${t.settledAt} is null and ${t.charged} = ${t.reserved}) or (${t.status} <> 'reserved' and ${t.settledAt} is not null)`,
    ),
    check(
      "llm_usage_tokens",
      sql`(${t.inputTokens} is null and ${t.outputTokens} is null and ${t.totalTokens} is null) or (${t.inputTokens} is not null and ${t.outputTokens} is not null and ${t.totalTokens} is not null and ${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.totalTokens} = ${t.inputTokens} + ${t.outputTokens})`,
    ),
    check(
      "llm_usage_diagnostics",
      sql`${t.retries} between 0 and 2 and (${t.latencyMs} is null or ${t.latencyMs} >= 0)`,
    ),
    index("llm_usage_account_status").on(t.accountId, t.status, t.settledAt),
  ],
);
