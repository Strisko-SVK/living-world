import { describe, expect, it, vi } from "vitest";
import {
  classifyNpcE2eReadiness,
  parseNpcE2eReadinessArguments,
  runNpcE2eReadinessCommand,
  type ReadinessFacts,
} from "./discord-npc-e2e-readiness.js";

const clean: ReadinessFacts = {
  fixture: "valid",
  route: "valid",
  routeRevision: true,
  policy: "disabled",
  playerMappings: 0,
  activeTestPlayer: false,
  matchingPresence: 0,
  presenceRecords: 0,
  policyAudits: 0,
  validActivationAudit: false,
  interactions: 0,
  deliveries: 0,
};

const rolePassword = "b".repeat(64);
const environment: NodeJS.ProcessEnv = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: "a".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD: rolePassword,
  DATABASE_URL:
    "postgresql://lw_gateway_dev:" +
    rolePassword +
    "@127.0.0.1:55432/living_world_gateway_dev",
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
  LW_DEV_GUILD_ID: "1566911648701223053",
  LW_DEV_PARENT_CHANNEL_ID: "1566913668795469934",
  LW_DEV_THREAD_ID: "1566914038158459090",
  LW_PILOT_PARENT_CHANNEL_ID: "1666913668795469934",
  LW_PILOT_THREAD_ID: "1666914038158459090",
  LW_NPC_E2E_PARENT_CHANNEL_ID: "1766913668795469934",
  LW_NPC_E2E_THREAD_ID: "1766914038158459090",
};

describe("M2.14 isolated NPC readiness, no writes and no live API", () => {
  it("permits only the nonmutating preview command", () => {
    expect(parseNpcE2eReadinessArguments([])).toBeUndefined();
    expect(parseNpcE2eReadinessArguments(["--preview"])).toBeUndefined();
    for (const command of [
      ["--apply"],
      ["--connect"],
      ["--execute"],
      ["--preview", "--apply"],
      ["--confirm-world", "lw-dev-npc-e2e-001"],
    ])
      expect(() => parseNpcE2eReadinessArguments(command)).toThrow();
  });

  it("classifies only exact pre-authorized evidence as ready", () => {
    expect(classifyNpcE2eReadiness(clean)).toBe("default_deny");
    expect(
      classifyNpcE2eReadiness({ ...clean, fixture: "missing", route: "free" }),
    ).toBe("fixture_missing");
    expect(
      classifyNpcE2eReadiness({ ...clean, fixture: "missing", route: "valid" }),
    ).toBe("blocked");
    expect(classifyNpcE2eReadiness({ ...clean, route: "conflict" })).toBe(
      "blocked",
    );
    expect(classifyNpcE2eReadiness({ ...clean, routeRevision: false })).toBe(
      "migration_required",
    );
    const ready: ReadinessFacts = {
      ...clean,
      policy: "mapped_players",
      playerMappings: 1,
      activeTestPlayer: true,
      matchingPresence: 1,
      presenceRecords: 1,
      policyAudits: 1,
      validActivationAudit: true,
    };
    expect(classifyNpcE2eReadiness(ready)).toBe("ready_for_inbound");
    for (const changed of [
      { activeTestPlayer: false },
      { matchingPresence: 0 },
      { playerMappings: 0 },
      { presenceRecords: 0 },
      { policyAudits: 0 },
      { validActivationAudit: false },
      { policy: "disabled" as const },
    ])
      expect(classifyNpcE2eReadiness({ ...ready, ...changed })).not.toBe(
        "ready_for_inbound",
      );
    expect(classifyNpcE2eReadiness({ ...ready, interactions: 1 })).toBe(
      "already_used",
    );
    expect(classifyNpcE2eReadiness({ ...ready, deliveries: 1 })).toBe(
      "already_used",
    );
    expect(classifyNpcE2eReadiness({ ...ready, presenceRecords: 2 })).toBe(
      "blocked",
    );
  });

  it("rejects unsafe environments and forged player identifiers without a DB connection", async () => {
    const connect = vi.fn();
    for (const bad of [
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { NODE_ENV: "production" },
      { LW_NPC_E2E_PARENT_CHANNEL_ID: environment.LW_PILOT_PARENT_CHANNEL_ID },
      { LW_NPC_E2E_TEST_USER_ID: "not-a-snowflake" },
      { LW_NPC_E2E_TEST_USER_ID: "1566909036899868712" },
      { LW_NPC_E2E_TEST_USER_ID: environment.LW_NPC_E2E_THREAD_ID },
      { DATABASE_URL: environment.DATABASE_URL?.replace("55432", "5432") },
    ])
      await expect(
        runNpcE2eReadinessCommand(
          [],
          { ...environment, ...bad },
          connect as unknown as Parameters<typeof runNpcE2eReadinessCommand>[2],
        ),
      ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });

  it("sets PostgreSQL read-only before any lookup and fails on wrong DB identity", async () => {
    const statements: string[] = [];
    const execute = vi.fn().mockImplementation(async (query: unknown) => {
      const text = String((query as { value?: string }).value ?? "");
      statements.push(text);
      return { rows: [] };
    });
    const transaction = vi
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute }),
      );
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockReturnValue({ db: { transaction }, close });
    await expect(
      runNpcE2eReadinessCommand(
        [],
        environment,
        connect as unknown as Parameters<typeof runNpcE2eReadinessCommand>[2],
      ),
    ).rejects.toThrow("identity is not approved");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(transaction).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
