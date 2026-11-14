import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  classifyMigration0018Preflight,
  expectedMigrationTimes,
  expectedMigration0019When,
  inspectMigration0018Preflight,
  isReviewedMigrationPlan,
  parseMigrationPreflightArguments,
  runMigration0018Preflight,
  type MigrationPreflightFacts,
} from "./scene-policy-migration-preflight.js";

const adminPassword = "a".repeat(64);
const rolePassword = "b".repeat(64);
const environment: NodeJS.ProcessEnv = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: adminPassword,
  LW_GATEWAY_DEV_ROLE_PASSWORD: rolePassword,
  DATABASE_URL:
    "postgresql://lw_gateway_dev:" +
    rolePassword +
    "@127.0.0.1:55432/living_world_gateway_dev",
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
};

const times = expectedMigrationTimes.map(String);
const prior = times.slice(0, -1);
const fixture = (): MigrationPreflightFacts => ({
  identityValid: true,
  migrationTablePresent: true,
  appliedTimes: prior,
  routeTriggerInstalled: true,
  policyTablePresent: false,
  policyUpdateTriggerInstalled: false,
  policyTruncateTriggerInstalled: false,
  policyObjectsIntact: false,
});

const isInert = (v: ReturnType<typeof classifyMigration0018Preflight>) => {
  expect(v).toMatchObject({
    readOnly: true,
    canMigrate: false,
    migration: "0018_scene_speech_policies",
  });
  expect(JSON.stringify(v)).not.toContain(rolePassword);
  expect(JSON.stringify(v)).not.toContain("DATABASE_URL");
};

describe("M2.15F read-only 0018 migration preflight", () => {
  it("pins all reviewed migrations through 0019 and rejects drift", async () => {
    const journal = JSON.parse(
      await readFile(
        new URL("../db/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    );
    const originalSql = await readFile(
      new URL(
        "../db/migrations/0018_scene_speech_policies.sql",
        import.meta.url,
      ),
    );
    const appendedSql = await readFile(
      new URL(
        "../db/migrations/0019_dev_first_reply_consents.sql",
        import.meta.url,
      ),
    );
    expect(isReviewedMigrationPlan(journal, originalSql, appendedSql)).toBe(
      true,
    );
    // An older 0018-only journal remains valid without a future migration.
    expect(
      isReviewedMigrationPlan(
        { ...journal, entries: journal.entries.slice(0, 19) },
        originalSql,
      ),
    ).toBe(true);
    // An appended journal cannot be trusted unless its exact SQL is pinned.
    expect(isReviewedMigrationPlan(journal, originalSql)).toBe(false);
    expect(
      isReviewedMigrationPlan(
        journal,
        originalSql,
        Buffer.concat([appendedSql, Buffer.from("\n-- unapproved append\n")]),
      ),
    ).toBe(false);
    expect(
      isReviewedMigrationPlan(
        {
          ...journal,
          entries: journal.entries.map((entry: { idx: number }) =>
            entry.idx === 19
              ? { ...entry, tag: "0019_unapproved_migration" }
              : entry,
          ),
        },
        originalSql,
        appendedSql,
      ),
    ).toBe(false);
    expect(
      isReviewedMigrationPlan(
        {
          ...journal,
          entries: journal.entries.map((entry: { idx: number }) =>
            entry.idx === 17 ? { ...entry, tag: "0017_unreviewed" } : entry,
          ),
        },
        originalSql,
        appendedSql,
      ),
    ).toBe(false);
    expect(
      isReviewedMigrationPlan(
        journal,
        Buffer.concat([originalSql, Buffer.from("\n-- unreviewed addition\n")]),
        appendedSql,
      ),
    ).toBe(false);
  });

  it("requires exactly the reviewed migration 0018 pending", () => {
    const v = classifyMigration0018Preflight(fixture());
    expect(v).toMatchObject({
      status: "ready_for_backup",
      reason: "pending_exactly_0018",
    });
    isInert(v);
  });

  it("recognizes an applied migration only if the table and both triggers exist", () => {
    const v = classifyMigration0018Preflight({
      ...fixture(),
      appliedTimes: times,
      policyTablePresent: true,
      policyUpdateTriggerInstalled: true,
      policyTruncateTriggerInstalled: true,
      policyObjectsIntact: true,
    });
    expect(v).toMatchObject({
      status: "already_applied",
      reason: "already_applied_verified",
    });
    isInert(v);
    const after0019 = classifyMigration0018Preflight({
      ...fixture(),
      appliedTimes: [...times, String(expectedMigration0019When)],
      policyTablePresent: true,
      policyUpdateTriggerInstalled: true,
      policyTruncateTriggerInstalled: true,
      policyObjectsIntact: true,
    });
    expect(after0019).toMatchObject({
      status: "already_applied",
      reason: "already_applied_verified",
    });
    isInert(after0019);
  });

  it("fails closed for changed, duplicated, skipped or future migration history", () => {
    const cases = [
      [],
      prior.slice(0, -1),
      [...prior, times[17]],
      [...times, String(Number(times[18]) + 1)],
      prior.map((x, i) => (i === 10 ? "0" : x)),
      times.map((x, i) => (i === 18 ? "0" : x)),
      [...times].reverse(),
    ];
    for (const appliedTimes of cases) {
      const v = classifyMigration0018Preflight({
        ...fixture(),
        appliedTimes,
      });
      expect(v).toMatchObject({
        status: "blocked",
        reason: "migration_history_drift",
      });
      isInert(v);
    }
  });

  it("fails on identity drift, missing journal and route revision trigger", () => {
    const cases: Array<[Partial<MigrationPreflightFacts>, string]> = [
      [{ identityValid: false }, "database_identity_mismatch"],
      [{ migrationTablePresent: false }, "migration_history_missing"],
      [{ routeTriggerInstalled: false }, "route_trigger_missing"],
    ];
    for (const [change, reason] of cases) {
      const v = classifyMigration0018Preflight({ ...fixture(), ...change });
      expect(v).toMatchObject({ status: "blocked", reason });
      isInert(v);
    }
  });

  it("refuses partial 0018 schema with or without recorded migration", () => {
    const before = fixture();
    const cases: MigrationPreflightFacts[] = [
      { ...before, policyTablePresent: true },
      { ...before, policyUpdateTriggerInstalled: true },
      { ...before, policyTruncateTriggerInstalled: true },
      { ...before, appliedTimes: times },
      {
        ...before,
        appliedTimes: times,
        policyTablePresent: true,
        policyUpdateTriggerInstalled: false,
        policyTruncateTriggerInstalled: true,
        policyObjectsIntact: false,
      },
      {
        ...before,
        appliedTimes: times,
        policyTablePresent: true,
        policyUpdateTriggerInstalled: true,
        policyTruncateTriggerInstalled: true,
        policyObjectsIntact: false,
      },
    ];
    for (const facts of cases) {
      const v = classifyMigration0018Preflight(facts);
      expect(v).toMatchObject({ status: "blocked", reason: "schema_partial" });
      isInert(v);
    }
  });

  it("only accepts the preview argument, never migration or repair flags", () => {
    expect(parseMigrationPreflightArguments([])).toBeUndefined();
    expect(parseMigrationPreflightArguments(["--preview"])).toBeUndefined();
    for (const args of [
      ["migrate"],
      ["--apply"],
      ["--reset"],
      ["--force"],
      ["--preview", "--apply"],
      ["--confirm-database", "living_world_gateway_dev"],
    ]) {
      expect(() => parseMigrationPreflightArguments(args)).toThrow();
    }
  });

  it("rejects unsafe environments before opening any database connection", async () => {
    const connect = vi.fn();
    const unsafe = [
      { NODE_ENV: "production" },
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { DATABASE_URL: environment.DATABASE_URL!.replace("55432", "5432") },
      {
        DATABASE_URL: environment.DATABASE_URL!.replace(
          "127.0.0.1",
          "example.org",
        ),
      },
      { LW_GATEWAY_DEV_ROLE_PASSWORD: "bad" },
      { DATABASE_URL: "not a URL" },
    ];
    for (const change of unsafe) {
      expect(
        await runMigration0018Preflight(
          ["--preview"],
          { ...environment, ...change },
          connect as unknown as Parameters<typeof runMigration0018Preflight>[2],
        ),
      ).toMatchObject({
        status: "blocked",
        reason: "unsafe_environment",
        canMigrate: false,
      });
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("starts a read-only transaction before identity queries and closes on blocked outcome", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute }),
    );
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockReturnValue({
      db: { transaction },
      close,
    });
    const v = await runMigration0018Preflight(
      ["--preview"],
      environment,
      connect as unknown as Parameters<typeof runMigration0018Preflight>[2],
    );
    expect(v).toMatchObject({
      status: "blocked",
      reason: "database_identity_mismatch",
    });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(execute.mock.calls[0])).toContain(
      "set transaction read only",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not reveal SQL exceptions or attempt a write on failed DB reads", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(Error("DO_NOT_EXPOSE_TEST_DIAGNOSTIC"));
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute }),
    );
    const v = await inspectMigration0018Preflight({
      transaction,
    } as unknown as Parameters<typeof inspectMigration0018Preflight>[0]);
    expect(v).toMatchObject({
      status: "blocked",
      reason: "read_failed",
      canMigrate: false,
    });
    expect(JSON.stringify(v)).not.toContain("DO_NOT_EXPOSE_TEST_DIAGNOSTIC");
    expect(execute).toHaveBeenCalledOnce();
  });
});
