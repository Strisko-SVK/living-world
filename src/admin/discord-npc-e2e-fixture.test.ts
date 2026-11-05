import { describe, expect, it, vi } from "vitest";
import {
  npcE2eWorldKey,
  parseNpcE2eFixtureArguments,
  runNpcE2eFixtureCommand,
  validateNpcE2eFixtureEnvironment,
} from "./discord-npc-e2e-fixture.js";

const rolePassword = "b".repeat(64);
const valid: NodeJS.ProcessEnv = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: "a".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD: rolePassword,
  DATABASE_URL: `postgresql://lw_gateway_dev:${rolePassword}@127.0.0.1:55432/living_world_gateway_dev`,
  NODE_ENV: "test",
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

describe("M2.13A isolated NPC E2E DEV fixture", () => {
  it("permits only a fresh parent/thread in the private DEV guild", () => {
    const expected = {
      guildId: valid.LW_DEV_GUILD_ID,
      channelId: valid.LW_NPC_E2E_PARENT_CHANNEL_ID,
      threadId: valid.LW_NPC_E2E_THREAD_ID,
    };
    expect(validateNpcE2eFixtureEnvironment(valid)).toEqual(expected);
    expect(
      validateNpcE2eFixtureEnvironment({
        ...valid,
        LW_NPC_E2E_GUILD_ID: valid.LW_DEV_GUILD_ID,
      }),
    ).toEqual(expected);
  });

  it("rejects legacy routes, reused IDs, wrong guild and missing IDs", () => {
    const changes = [
      { LW_NPC_E2E_PARENT_CHANNEL_ID: valid.LW_DEV_PARENT_CHANNEL_ID },
      { LW_NPC_E2E_THREAD_ID: valid.LW_DEV_THREAD_ID },
      { LW_NPC_E2E_PARENT_CHANNEL_ID: valid.LW_PILOT_PARENT_CHANNEL_ID },
      { LW_NPC_E2E_THREAD_ID: valid.LW_PILOT_THREAD_ID },
      { LW_NPC_E2E_THREAD_ID: valid.LW_DEV_PARENT_CHANNEL_ID },
      { LW_NPC_E2E_PARENT_CHANNEL_ID: valid.LW_PILOT_THREAD_ID },
      { LW_NPC_E2E_THREAD_ID: valid.LW_NPC_E2E_PARENT_CHANNEL_ID },
      { LW_NPC_E2E_PARENT_CHANNEL_ID: valid.LW_DEV_GUILD_ID },
      { LW_NPC_E2E_GUILD_ID: "1966911648701223053" },
      { LW_NPC_E2E_PARENT_CHANNEL_ID: undefined },
      { LW_NPC_E2E_THREAD_ID: undefined },
      { LW_NPC_E2E_PARENT_CHANNEL_ID: "123" },
      { LW_PILOT_THREAD_ID: undefined },
    ];
    for (const change of changes) {
      expect(() =>
        validateNpcE2eFixtureEnvironment({ ...valid, ...change }),
      ).toThrow();
    }
  });

  it("rejects live network, paid generation and unsafe DB configuration", () => {
    const changes = [
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { NODE_ENV: "production" },
      { DATABASE_URL: valid.DATABASE_URL?.replace("gateway_dev", "prod") },
      { DATABASE_URL: valid.DATABASE_URL?.replace("55432", "5432") },
      { LW_GATEWAY_DEV_ROLE_PASSWORD: "wrong" },
      {
        DATABASE_URL:
          "postgresql://lw_gateway_dev:x@192.0.2.1:55432/living_world_gateway_dev",
      },
      { DATABASE_URL: valid.DATABASE_URL + "?host=192.0.2.1" },
    ];
    for (const change of changes) {
      expect(() =>
        validateNpcE2eFixtureEnvironment({ ...valid, ...change }),
      ).toThrow();
    }
  });

  it("defaults to preview and requires exact apply confirmations", () => {
    expect(parseNpcE2eFixtureArguments([])).toBe(false);
    expect(parseNpcE2eFixtureArguments(["--preview"])).toBe(false);
    expect(
      parseNpcE2eFixtureArguments([
        "--apply",
        "--confirm-world",
        npcE2eWorldKey,
        "--confirm-database",
        "living_world_gateway_dev",
      ]),
    ).toBe(true);
    for (const args of [
      ["--apply"],
      ["--connect"],
      ["--delete"],
      [
        "--apply",
        "--confirm-world",
        "lw-dev-pilot-001",
        "--confirm-database",
        "living_world_gateway_dev",
      ],
      [
        "--apply",
        "--confirm-world",
        npcE2eWorldKey,
        "--confirm-database",
        "living_world_prod",
      ],
    ]) {
      expect(() => parseNpcE2eFixtureArguments(args)).toThrow();
    }
  });

  it("checks identity in the provisioning transaction", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            database: "living_world_gateway_dev",
            db_role: "lw_gateway_dev",
            version: 170011,
            superuser: false,
          },
        ],
      });
    const innerTransaction = vi.fn().mockResolvedValue({
      status: "would_create",
      worldKey: npcE2eWorldKey,
    });
    const transaction = vi
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute, transaction: innerTransaction }),
      );
    const connect = vi.fn().mockReturnValue({ db: { transaction }, close });
    await expect(
      runNpcE2eFixtureCommand(
        [],
        valid,
        connect as unknown as Parameters<typeof runNpcE2eFixtureCommand>[2],
      ),
    ).resolves.toEqual({ status: "would_create", worldKey: npcE2eWorldKey });
    expect(connect).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
    expect(innerTransaction).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("denies privileged database sessions before provisioning", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            database: "living_world_gateway_dev",
            db_role: "postgres",
            version: 170011,
            superuser: true,
          },
        ],
      });
    const innerTransaction = vi.fn();
    const transaction = vi
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute, transaction: innerTransaction }),
      );
    const connect = vi.fn().mockReturnValue({ db: { transaction }, close });
    await expect(
      runNpcE2eFixtureCommand(
        [],
        valid,
        connect as unknown as Parameters<typeof runNpcE2eFixtureCommand>[2],
      ),
    ).rejects.toThrow("not approved");
    expect(innerTransaction).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects unsafe environment without connecting", async () => {
    const connect = vi.fn();
    await expect(
      runNpcE2eFixtureCommand(
        [],
        { ...valid, DISCORD_OUTBOUND_ENABLED: "true" },
        connect as unknown as Parameters<typeof runNpcE2eFixtureCommand>[2],
      ),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});
