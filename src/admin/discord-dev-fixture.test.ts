import { describe, expect, it, vi } from "vitest";
import {
  parseDevFixtureArguments,
  validateDevFixtureEnvironment,
  devWorldKey,
  runDevFixtureCommand,
} from "./discord-dev-fixture.js";

const valid = {
  DATABASE_URL:
    "postgresql://lw_gateway_dev:password@127.0.0.1:5432/living_world_gateway_dev",
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
  LW_DEV_GUILD_ID: "1111111111111111111",
  LW_DEV_PARENT_CHANNEL_ID: "1222222222222222222",
  LW_DEV_THREAD_ID: "1333333333333333333",
};

describe("offline Discord DEV fixture guards", () => {
  it("defaults to preview and demands explicit named database for apply", () => {
    expect(parseDevFixtureArguments([])).toBe(false);
    expect(
      parseDevFixtureArguments([
        "--apply",
        "--confirm-database",
        "living_world_gateway_dev",
      ]),
    ).toBe(true);
    expect(() => parseDevFixtureArguments(["--apply"])).toThrow();
    expect(devWorldKey).toBe("lw-dev-gateway-001");
  });

  it("accepts only three distinct valid route identifiers", () => {
    expect(validateDevFixtureEnvironment(valid)).toEqual({
      guildId: valid.LW_DEV_GUILD_ID,
      channelId: valid.LW_DEV_PARENT_CHANNEL_ID,
      threadId: valid.LW_DEV_THREAD_ID,
    });
    for (const override of [
      { LW_DEV_THREAD_ID: valid.LW_DEV_PARENT_CHANNEL_ID },
      { LW_DEV_GUILD_ID: "invalid" },
      { LW_DEV_THREAD_ID: "" },
    ]) {
      expect(() =>
        validateDevFixtureEnvironment({ ...valid, ...override }),
      ).toThrow();
    }
  });

  it("rejects non-isolated database endpoints, including remote hosts and other DBs", () => {
    for (const url of [
      "postgresql://lw_gateway_dev:password@db.example.com/living_world_gateway_dev",
      "postgresql://lw_gateway_dev:password@127.0.0.1/living_world",
      "postgresql://lw_gateway_dev:password@127.0.0.1/living_world_gateway_dev?sslmode=require",
      "file:///tmp/living_world_gateway_dev",
      "postgresql://postgres:password@127.0.0.1/living_world_gateway_dev",
      "postgresql://lw_gateway_dev@127.0.0.1/living_world_gateway_dev",
      "postgresql://lw_gateway_dev:password@127.0.0.1/living_world_gateway_dev#fragment",
    ]) {
      expect(() =>
        validateDevFixtureEnvironment({ ...valid, DATABASE_URL: url }),
      ).toThrow();
    }
    expect(() =>
      validateDevFixtureEnvironment({ ...valid, DATABASE_URL: "" }),
    ).toThrow();
  });

  it("rejects any enabled network or paid generation mode", () => {
    for (const override of [
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { NODE_ENV: "production" },
    ]) {
      expect(() =>
        validateDevFixtureEnvironment({ ...valid, ...override }),
      ).toThrow();
    }
  });
  it("rejects an unexpected or privileged database role before provisioning", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          database: "living_world_gateway_dev",
          db_role: "postgres",
          superuser: true,
          version: 170003,
        },
      ],
    });
    const innerTransaction = vi.fn();
    const transaction = vi.fn().mockImplementation(
      async (
        callback: (tx: {
          execute: typeof execute;
          transaction: typeof innerTransaction;
        }) => Promise<unknown>,
      ) => callback({ execute, transaction: innerTransaction }),
    );
    const connect = vi.fn().mockReturnValue({
      db: { transaction },
      close,
    });
    await expect(
      runDevFixtureCommand(
        [],
        valid,
        connect as unknown as Parameters<typeof runDevFixtureCommand>[2],
      ),
    ).rejects.toThrow("database identity is not approved");
    expect(transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(innerTransaction).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });


  it("checks an approved role within the same transaction as provisioning", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          database: "living_world_gateway_dev",
          db_role: "lw_gateway_dev",
          superuser: false,
          version: 170003,
        },
      ],
    });
    const innerTransaction = vi.fn().mockResolvedValue({
      status: "would_create",
      worldKey: devWorldKey,
    });
    const transaction = vi.fn().mockImplementation(
      async (
        callback: (tx: {
          execute: typeof execute;
          transaction: typeof innerTransaction;
        }) => Promise<unknown>,
      ) => callback({ execute, transaction: innerTransaction }),
    );
    const connect = vi.fn().mockReturnValue({ db: { transaction }, close });
    await expect(
      runDevFixtureCommand(
        [],
        valid,
        connect as unknown as Parameters<typeof runDevFixtureCommand>[2],
      ),
    ).resolves.toEqual({ status: "would_create", worldKey: devWorldKey });
    expect(transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(innerTransaction).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
