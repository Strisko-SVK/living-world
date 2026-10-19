import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseClient } from "./client.js";
import { getDatabaseConfig } from "./config.js";
import {
  createBudgetStore,
  getLlmBudgetSummary,
} from "../llm/budget.repository.js";
import type { Reservation, Settlement } from "../llm/contracts.js";

// A unique schema applies the actual forward migration, with only its explicit
// public FK qualifier relocated. No live budget/accounting records are touched.
const admin = new Pool({ connectionString: getDatabaseConfig().databaseUrl });
let pool: Pool;
let schema: string;
let store: ReturnType<typeof createBudgetStore>;
let db: DatabaseClient["db"];
beforeEach(async () => {
  schema = "llm_test_" + randomUUID().replaceAll("-", "");
  await admin.query(`create schema "${schema}"`);
  pool = new Pool({
    connectionString: getDatabaseConfig().databaseUrl,
    options: `-c search_path=${schema},public`,
  });
  const migration = readFileSync(
    new URL("./migrations/0010_llm_budget_accounting.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration.replaceAll('"public".', `"${schema}".`));
  db = drizzle({ client: pool });
  store = createBudgetStore(db);
});
afterEach(async () => {
  if (pool) await pool.end();
  if (schema) {
    await admin.query(`drop table if exists "${schema}".llm_usage`);
    await admin.query(`drop table if exists "${schema}".llm_budget`);
    await admin.query(`drop schema "${schema}"`);
  }
});
// Admin pool has no persistent checked-out clients; close after this file.
afterAll(async () => admin.end());
const reservation = (overrides: Partial<Reservation> = {}): Reservation => ({
  id: randomUUID(),
  traceId: randomUUID(),
  provider: "openai",
  model: "synthetic-model",
  currency: "USD",
  ceiling: 100n,
  reserved: 60n,
  inputRate: 1n,
  outputRate: 2n,
  ...overrides,
});
const settlement = (overrides: Partial<Settlement> = {}): Settlement => ({
  charged: 10n,
  uncertain: false,
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
  outcome: "success",
  retries: 0,
  latencyMs: 1,
  ...overrides,
});
describe("durable LLM accounting", () => {
  it("marks partial known usage as incomplete when earlier attempts may have been billed", async () => {
    const value = reservation();
    await store.reserve(value);
    await store.settle(value.id, settlement({ charged: 40n, uncertain: true }));
    expect((await getLlmBudgetSummary(db)).usage).toMatchObject({
      inputTokens: "2",
      outputTokens: "3",
      unknownUsage: 1,
      unresolvedMicros: "40",
      monthlyEstimatedMicros: "0",
    });
  });
  it("serializes concurrent reservations across separate database connections", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.reserve(reservation())),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await getLlmBudgetSummary(db)).usage).toMatchObject({
      liabilityMicros: "60",
      pending: 1,
    });
  });
  it("settles recorded usage, releases unused capacity and prevents double settlement", async () => {
    const value = reservation();
    expect(await store.reserve(value)).toBe(true);
    await store.settle(value.id, settlement());
    expect((await getLlmBudgetSummary(db)).usage).toMatchObject({
      liabilityMicros: "10",
      inputTokens: "2",
      outputTokens: "3",
    });
    expect(await store.reserve(reservation({ reserved: 90n }))).toBe(true);
    await expect(
      store.settle(value.id, settlement({ charged: 0n })),
    ).rejects.toThrow("not pending");
  });
  it("retains abandoned reservations across UTC monthly boundaries", async () => {
    const value = reservation();
    await store.reserve(value);
    await pool.query(
      "update llm_usage set created_at = date_trunc('month', current_timestamp at time zone 'UTC') at time zone 'UTC' - interval '1 month' where id=$1",
      [value.id],
    );
    expect(await store.reserve(reservation())).toBe(false);
  });
  it("retains uncertain charges across month boundaries rather than granting unlimited retries", async () => {
    const value = reservation();
    await store.reserve(value);
    await store.settle(
      value.id,
      settlement({
        charged: 60n,
        uncertain: true,
        usage: null,
        outcome: "timeout",
      }),
    );
    await pool.query(
      "update llm_usage set settled_at = current_timestamp - interval '2 months' where id=$1",
      [value.id],
    );
    expect(await store.reserve(reservation())).toBe(false);
    expect((await getLlmBudgetSummary(db)).usage.unknownUsage).toBe(1);
  });
  it("resets evaluated monthly settled spending at the UTC boundary, not outstanding liabilities", async () => {
    const value = reservation();
    await store.reserve(value);
    await store.settle(value.id, settlement({ charged: 60n }));
    expect(await store.reserve(reservation())).toBe(false);
    await pool.query(
      "update llm_usage set settled_at = date_trunc('month', current_timestamp at time zone 'UTC') at time zone 'UTC' - interval '1 microsecond' where id=$1",
      [value.id],
    );
    expect(await store.reserve(reservation())).toBe(true);
  });
  it("prevents changing currency or raising the shared ceiling from another caller", async () => {
    await store.reserve(reservation());
    expect(await store.reserve(reservation({ currency: "EUR" }))).toBe(false);
    expect(await store.reserve(reservation({ ceiling: 1000n }))).toBe(false);
    expect((await getLlmBudgetSummary(db)).account).toMatchObject({
      currency: "USD",
      ceiling: 100n,
    });
  });
  it("rolls back invalid token accounting and leaves the full reservation intact", async () => {
    const value = reservation();
    await store.reserve(value);
    await expect(
      store.settle(
        value.id,
        settlement({
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 4 },
        }),
      ),
    ).rejects.toThrow();
    expect((await getLlmBudgetSummary(db)).usage.liabilityMicros).toBe("60");
  });
  it("rejects duplicate durable reservation IDs and invalid amounts at the database boundary", async () => {
    const value = reservation({ reserved: 10n });
    await store.reserve(value);
    await expect(store.reserve(value)).rejects.toThrow();
    await expect(
      pool.query("update llm_usage set charged_micros=-1 where id=$1", [
        value.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("update llm_usage set status='forgotten' where id=$1", [
        value.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await getLlmBudgetSummary(db)).usage.liabilityMicros).toBe("10");
  });
  it("records higher-than-reserved usage rather than hiding overspend and stops subsequent calls", async () => {
    const value = reservation();
    await store.reserve(value);
    await store.settle(value.id, settlement({ charged: 110n }));
    expect(await store.reserve(reservation({ reserved: 1n }))).toBe(false);
    expect((await getLlmBudgetSummary(db)).usage.liabilityMicros).toBe("110");
  });
  it("releases definitively unbilled cancelled-before-send or rejected requests", async () => {
    const value = reservation();
    await store.reserve(value);
    await store.settle(
      value.id,
      settlement({ charged: 0n, usage: null, outcome: "cancelled" }),
    );
    expect(await store.reserve(reservation({ reserved: 100n }))).toBe(true);
  });
});
