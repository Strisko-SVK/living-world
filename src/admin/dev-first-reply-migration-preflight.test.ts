import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyMigration0019Preflight,
  inspectMigration0019Preflight,
  parseMigration0019Arguments,
  runMigration0019Preflight,
  type Migration0019Facts,
  type Migration0019Preview,
} from "./dev-first-reply-migration-preflight.js";
import {
  expectedMigration0019When,
  expectedMigrationTimes,
} from "./scene-policy-migration-preflight.js";

const adminPassword = "a".repeat(64);
const rolePassword = "b".repeat(64);
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  LW_GATEWAY_DEV_ADMIN_PASSWORD: adminPassword,
  LW_GATEWAY_DEV_ROLE_PASSWORD: rolePassword,
  DATABASE_URL: "postgresql://lw_gateway_dev:" +
    rolePassword + "@127.0.0.1:55432/living_world_gateway_dev",
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
};

const baseline = [...expectedMigrationTimes.map(String)];
const full = [...baseline, String(expectedMigration0019When)];
function fixture(): Migration0019Facts {
  return {
    identityValid: true,
    migrationTablePresent: true,
    appliedTimes: baseline,
    baseline0018Intact: true,
    consentTablePresent: false,
    guardFunctionPresent: false,
    guardFunctionIntact: false,
    immutableTriggerIntact: false,
    truncateTriggerIntact: false,
    constraintsIntact: false,
    columnsIntact: false,
    indexIntact: false,
    rlsDisabled: false,
  };
}
function applied(): Migration0019Facts {
  return {
    ...fixture(),
    appliedTimes: full,
    consentTablePresent: true,
    guardFunctionPresent: true,
    guardFunctionIntact: true,
    immutableTriggerIntact: true,
    truncateTriggerIntact: true,
    constraintsIntact: true,
    columnsIntact: true,
    indexIntact: true,
    rlsDisabled: true,
  };
}
function assertInert(v: Migration0019Preview) {
  expect(v).toMatchObject({
    event: "npc_dev_first_reply_migration_preflight",
    migration: "0019_dev_first_reply_consents",
    readOnly: true,
    canMigrate: false,
    canSend: false,
  });
  expect(JSON.stringify(v)).not.toContain(rolePassword);
}
afterEach(() => vi.unstubAllEnvs());

describe("M2.15N read-only 0019 migration preflight", () => {
  it("identifies only an exact 0018-applied / 0019-absent schema as pending", () => {
    const preview = classifyMigration0019Preflight(fixture());
    expect(preview).toMatchObject({
      status: "ready_for_backup",
      reason: "pending_exactly_0019",
    });
    assertInert(preview);
    expect(classifyMigration0019Preflight(applied())).toMatchObject({
      status: "already_applied",
      reason: "already_applied_verified",
    });
    assertInert(classifyMigration0019Preflight(applied()));
  });

  it.each([
    ["wrong identity", { identityValid: false }, "database_identity_mismatch"],
    ["absent journal", { migrationTablePresent: false }, "migration_history_missing"],
    ["missing 0018 guards", { baseline0018Intact: false }, "baseline_0018_invalid"],
    ["half schema", { consentTablePresent: true }, "schema_partial"],
    ["stray function", { guardFunctionPresent: true }, "schema_partial"],
    ["stray trigger", { truncateTriggerIntact: true }, "schema_partial"],
  ] as const)("blocks %s before migration", (_label, change, reason) => {
    const v = classifyMigration0019Preflight({ ...fixture(), ...change });
    expect(v).toMatchObject({ status: "blocked", reason });
    assertInert(v);
  });

  it.each([
    "consentTablePresent",
    "guardFunctionPresent",
    "guardFunctionIntact",
    "immutableTriggerIntact",
    "truncateTriggerIntact",
    "constraintsIntact",
    "columnsIntact",
    "indexIntact",
    "rlsDisabled",
  ] as const)("blocks applied 0019 if %s drifts", (field) => {
    const v = classifyMigration0019Preflight({ ...applied(), [field]: false });
    expect(v).toMatchObject({
      status: "blocked",
      reason: "schema_partial",
    });
    assertInert(v);
  });

  it("rejects missing, reordered, duplicated and unknown migrations", () => {
    const invalid = [
      [],
      baseline.slice(0, -1),
      [...baseline, baseline[18]!],
      [...full, "9999999999999"],
      [...baseline.slice(0, 18), String(Number(baseline[18]) + 1)],
      [...baseline.slice(0, 17), "0", baseline[18]!],
      [...full].reverse(),
    ];
    for (const appliedTimes of invalid) {
      const v = classifyMigration0019Preflight({
        ...applied(),
        appliedTimes,
      });
      expect(v).toMatchObject({
        status: "blocked",
        reason: "migration_history_drift",
      });
      assertInert(v);
    }
  });

  it("allows only --preview and never a migration, apply or reset flag", () => {
    expect(parseMigration0019Arguments([])).toBeUndefined();
    expect(parseMigration0019Arguments(["--preview"])).toBeUndefined();
    for (const flags of [
      ["migrate"], ["--apply"], ["--reset"], ["--force"],
      ["--preview", "--apply"], ["--confirm-database", "living_world_gateway_dev"],
    ])
      expect(() => parseMigration0019Arguments(flags)).toThrow();
  });

  it.each([
    { NODE_ENV: "production" },
    { DISCORD_ENABLED: "true" },
    { DISCORD_OUTBOUND_ENABLED: "true" },
    { LLM_PROVIDER: "openai" },
    { DATABASE_URL: env.DATABASE_URL!.replace("55432", "5432") },
    { DATABASE_URL: env.DATABASE_URL!.replace("127.0.0.1", "example.org") },
    { LW_GATEWAY_DEV_ROLE_PASSWORD: "short" },
    { DATABASE_URL: "not a database URL" },
  ])("refuses an unsafe environment before opening any DB connection", async (patch) => {
    const connect = vi.fn();
    expect(await runMigration0019Preflight(
      ["--preview"],
      { ...env, ...patch },
      connect as unknown as Parameters<typeof runMigration0019Preflight>[2],
    )).toMatchObject({
      status: "blocked",
      reason: "unsafe_environment",
      canMigrate: false,
      canSend: false,
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("blocks --send and --apply even with valid DEV credentials", async () => {
    const connect = vi.fn();
    for (const flag of ["--send", "--apply"]) {
      const v = await runMigration0019Preflight(
        [flag], env,
        connect as unknown as Parameters<typeof runMigration0019Preflight>[2],
      );
      expect(v.reason).toBe("unsafe_environment");
      assertInert(v);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("enforces PostgreSQL read-only as the first statement and stops on DB identity mismatch", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ execute }),
    );
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(() => ({ db: { transaction }, close }));
    const v = await runMigration0019Preflight(
      ["--preview"],
      env,
      connect as unknown as Parameters<typeof runMigration0019Preflight>[2],
    );
    expect(v).toMatchObject({
      status: "blocked",
      reason: "database_identity_mismatch",
    });
    assertInert(v);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(execute.mock.calls[0])).toContain(
      "set transaction read only",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses CI identity override outside unit-test mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const transaction = vi.fn();
    const v = await inspectMigration0019Preflight(
      { transaction } as unknown as Parameters<typeof inspectMigration0019Preflight>[0],
      { database: "living_world_ci", role: "living_world_ci" },
    );
    expect(v.reason).toBe("unsafe_environment");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("redacts unexpected DB errors and never returns migration permission", async () => {
    const execute = vi.fn().mockRejectedValue(
      new Error("private database password or Discord player text"),
    );
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ execute }),
    );
    const v = await inspectMigration0019Preflight(
      { transaction } as unknown as Parameters<typeof inspectMigration0019Preflight>[0],
    );
    expect(v).toMatchObject({ status: "blocked", reason: "read_failed" });
    assertInert(v);
    expect(JSON.stringify(v)).not.toContain("private");
    expect(execute).toHaveBeenCalledOnce();
  });
});
