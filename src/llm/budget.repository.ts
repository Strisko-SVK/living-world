import { and, eq, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { llmBudget, llmUsage } from "../db/schema/llm-accounting.js";
import type { BudgetStore } from "./contracts.js";

type Database = Omit<DatabaseClient["db"], "$client">;
// Outstanding liabilities remain charged across month boundaries. Never expire
// an uncertain/abandoned call just because a lease or a calendar month elapsed.
const liability = sql`status in ('reserved', 'uncertain') or
  settled_at >= date_trunc('month', current_timestamp at time zone 'UTC') at time zone 'UTC'`;
export function createBudgetStore(database: Database): BudgetStore {
  return {
    reserve: (value) =>
      database.transaction(async (tx) => {
        await tx
          .insert(llmBudget)
          .values({
            id: "llm",
            currency: value.currency,
            ceiling: value.ceiling,
          })
          .onConflictDoNothing();
        const [account] = await tx
          .select()
          .from(llmBudget)
          .where(eq(llmBudget.id, "llm"))
          .for("update");
        if (account.currency !== value.currency) return false;
        const ceiling =
          account.ceiling < value.ceiling ? account.ceiling : value.ceiling;
        await tx
          .update(llmBudget)
          .set({ ceiling })
          .where(eq(llmBudget.id, "llm"));
        const [sum] = await tx
          .select({
            amount: sql<string>`coalesce(sum(charged_micros), 0)::text`,
          })
          .from(llmUsage)
          .where(liability);
        if (
          value.reserved <= 0n ||
          BigInt(sum.amount) + value.reserved > ceiling
        )
          return false;
        await tx.insert(llmUsage).values({
          id: value.id,
          traceId: value.traceId,
          accountId: "llm",
          provider: value.provider,
          model: value.model,
          reserved: value.reserved,
          charged: value.reserved,
          inputRate: value.inputRate,
          outputRate: value.outputRate,
          status: "reserved",
          outcome: "pending",
        });
        return true;
      }),
    settle: async (id, value) => {
      await database.transaction(async (tx) => {
        await tx
          .select()
          .from(llmBudget)
          .where(eq(llmBudget.id, "llm"))
          .for("update");
        const rows = await tx
          .update(llmUsage)
          .set({
            charged: value.charged,
            status: value.uncertain ? "uncertain" : "settled",
            outcome: value.outcome,
            retries: value.retries,
            latencyMs: value.latencyMs,
            inputTokens: value.usage?.inputTokens ?? null,
            outputTokens: value.usage?.outputTokens ?? null,
            totalTokens: value.usage?.totalTokens ?? null,
            requestId: value.requestId,
            settledAt: sql`current_timestamp`,
          })
          .where(and(eq(llmUsage.id, id), eq(llmUsage.status, "reserved")))
          .returning({ id: llmUsage.id });
        if (rows.length !== 1)
          throw new Error("LLM reservation is not pending.");
      });
    },
  };
}
export async function getLlmBudgetSummary(database: Database) {
  const [account] = await database
    .select()
    .from(llmBudget)
    .where(eq(llmBudget.id, "llm"));
  const [usage] = await database
    .select({
      liabilityMicros: sql<string>`coalesce(sum(charged_micros) filter (where ${liability}),0)::text`,
      inputTokens: sql<string>`coalesce(sum(input_tokens),0)::text`,
      outputTokens: sql<string>`coalesce(sum(output_tokens),0)::text`,
      monthlyInputTokens: sql<string>`coalesce(sum(input_tokens) filter (where settled_at >= date_trunc('month', current_timestamp at time zone 'UTC') at time zone 'UTC'),0)::text`,
      monthlyOutputTokens: sql<string>`coalesce(sum(output_tokens) filter (where settled_at >= date_trunc('month', current_timestamp at time zone 'UTC') at time zone 'UTC'),0)::text`,
      monthlyEstimatedMicros: sql<string>`coalesce(sum(charged_micros) filter (where status = 'settled' and settled_at >= date_trunc('month', current_timestamp at time zone 'UTC') at time zone 'UTC'),0)::text`,
      unresolvedMicros: sql<string>`coalesce(sum(charged_micros) filter (where status in ('reserved', 'uncertain')),0)::text`,
      unknownUsage: sql<number>`count(*) filter (where input_tokens is null or status in ('reserved', 'uncertain'))::int`,
      // The original reservation and truthful settlement already form a durable
      // anomaly record. Derive this signal without another ledger or migration.
      reservationOverruns: sql<number>`count(*) filter (where status <> 'reserved' and charged_micros > reserved_micros)::int`,
      reservationOverageMicros: sql<string>`coalesce(sum(greatest(charged_micros-reserved_micros,0)) filter (where status <> 'reserved'),0)::text`,
      pending: sql<number>`count(*) filter (where status = 'reserved')::int`,
    })
    .from(llmUsage);
  return { account: account ?? null, usage };
}
