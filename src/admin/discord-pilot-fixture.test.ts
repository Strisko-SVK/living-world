import { describe, expect, it, vi } from "vitest";
import {
  parsePilotFixtureArguments,
  pilotWorldKey,
  runPilotFixtureCommand,
  validatePilotFixtureEnvironment,
} from "./discord-pilot-fixture.js";

const rolePassword = "b".repeat(64);
const valid: NodeJS.ProcessEnv = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: "a".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD: rolePassword,
  DATABASE_URL: `postgresql://lw_gateway_dev:${rolePassword}@127.0.0.1:55432/living_world_gateway_dev`,
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
  LW_DEV_GUILD_ID: "1566911648701223053",
  LW_DEV_PARENT_CHANNEL_ID: "1566913668795469934",
  LW_DEV_THREAD_ID: "1566914038158459090",
  LW_PILOT_PARENT_CHANNEL_ID: "1666913668795469934",
  LW_PILOT_THREAD_ID: "1666914038158459090",
};

describe("Step 11 isolated pilot fixture preflight", () => {
  it("requires a different parent channel and thread in the same private DEV guild", () => {
    expect(validatePilotFixtureEnvironment(valid)).toEqual({
      guildId: valid.LW_DEV_GUILD_ID,
      channelId: valid.LW_PILOT_PARENT_CHANNEL_ID,
      threadId: valid.LW_PILOT_THREAD_ID,
    });
    for (const changes of [
      { LW_PILOT_PARENT_CHANNEL_ID: valid.LW_DEV_PARENT_CHANNEL_ID },
      { LW_PILOT_PARENT_CHANNEL_ID: valid.LW_DEV_THREAD_ID },
      { LW_PILOT_THREAD_ID: valid.LW_DEV_THREAD_ID },
      { LW_PILOT_THREAD_ID: valid.LW_PILOT_PARENT_CHANNEL_ID },
      { LW_PILOT_PARENT_CHANNEL_ID: undefined },
      { LW_PILOT_THREAD_ID: "" },
      { LW_PILOT_PARENT_CHANNEL_ID: "not-an-id" },
      { LW_PILOT_GUILD_ID: "1666911648701223053" },
    ]) {
      expect(() =>
        validatePilotFixtureEnvironment({ ...valid, ...changes }),
      ).toThrow();
    }
    expect(() =>
      validatePilotFixtureEnvironment({
        ...valid,
        LW_PILOT_GUILD_ID: valid.LW_DEV_GUILD_ID,
      }),
    ).not.toThrow();
  });

  it("fails closed if network, payment or database isolation is relaxed", () => {
    for (const changes of [
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { NODE_ENV: "production" },
      { DATABASE_URL: valid.DATABASE_URL?.replace("55432", "5432") },
      { DATABASE_URL: valid.DATABASE_URL?.replace("gateway_dev", "production") },
      { LW_GATEWAY_DEV_ROLE_PASSWORD: "wrong" },
    ]) {
      expect(() =>
        validatePilotFixtureEnvironment({ ...valid, ...changes }),
      ).toThrow();
    }
  });

  it("defaults to non-mutating preview and requires both exact apply confirmations", () => {
    expect(parsePilotFixtureArguments([])).toBe(false);
    expect(parsePilotFixtureArguments(["--preview"])).toBe(false);
    expect(
      parsePilotFixtureArguments([
        "--apply",
        "--confirm-world",
        pilotWorldKey,
        "--confirm-database",
        "living_world_gateway_dev",
      ]),
    ).toBe(true);
    for (const args of [
      ["--apply"],
      ["--apply", "--confirm-world", "lw-dev-gateway-001", "--confirm-database", "living_world_gateway_dev"],
      ["--apply", "--confirm-world", pilotWorldKey, "--confirm-database", "living_world"],
      ["--delete"],
    ]) {
      expect(() => parsePilotFixtureArguments(args)).toThrow();
    }
  });

  it("checks database identity in same transaction before fixture preview", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            database: "living_world_gateway_dev",
            db_role: "lw_gateway_dev",
            version: 170003,
            superuser: false,
          },
        ],
      });
    const innerTransaction = vi.fn().mockResolvedValue({
      status: "would_create",
      worldKey: pilotWorldKey,
    });
    const transaction = vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute, transaction: innerTransaction }),
    );
    const connect = vi.fn().mockReturnValue({ db: { transaction }, close });
    await expect(
      runPilotFixtureCommand(
        [],
        valid,
        connect as unknown as Parameters<typeof runPilotFixtureCommand>[2],
      ),
    ).resolves.toEqual({ status: "would_create", worldKey: pilotWorldKey });
    expect(connect).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
    expect(innerTransaction).toHaveBeenCalledOnce();
    expect(innerTransaction.mock.calls[0]![0]).toEqual(expect.any(Function));
    expect(close).toHaveBeenCalledOnce();
  });

  it("denies privileged DB identity before provisioning and still closes", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            database: "living_world_gateway_dev",
            db_role: "postgres",
            version: 170003,
            superuser: true,
          },
        ],
      });
    const innerTransaction = vi.fn();
    const transaction = vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute, transaction: innerTransaction }),
    );
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockReturnValue({ db: { transaction }, close });
    await expect(
      runPilotFixtureCommand(
        [],
        valid,
        connect as unknown as Parameters<typeof runPilotFixtureCommand>[2],
      ),
    ).rejects.toThrow("not approved");
    expect(innerTransaction).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
