import { describe, expect, it, vi } from "vitest";
import {
  parsePilotPlayerArguments,
  runPilotPlayerCommand,
  validatePilotPlayerEnvironment,
} from "./discord-pilot-player.js";

const password = "b".repeat(64);
const env: NodeJS.ProcessEnv = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: "a".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD: password,
  DATABASE_URL: `postgresql://lw_gateway_dev:${password}@127.0.0.1:55432/living_world_gateway_dev`,
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
  LW_DEV_GUILD_ID: "1566911648701223053",
  LW_DEV_PARENT_CHANNEL_ID: "1566913668795469934",
  LW_DEV_THREAD_ID: "1566914038158459090",
  LW_PILOT_PARENT_CHANNEL_ID: "1567604837309350030",
  LW_PILOT_THREAD_ID: "1567605016603271208",
  LW_PILOT_TEST_USER_ID: "1766911648701223053",
};
const world = "lw-dev-pilot-001";
const database = "living_world_gateway_dev";

describe("Step 12 local pilot player safety gates", () => {
  it("defaults to read-only preview; only exact world/database flags permit write", () => {
    expect(parsePilotPlayerArguments([])).toBe("preview");
    expect(parsePilotPlayerArguments(["--preview"])).toBe("preview");
    for (const action of ["enroll", "revoke"] as const)
      expect(
        parsePilotPlayerArguments([
          "--" + action,
          "--confirm-world",
          world,
          "--confirm-database",
          database,
        ]),
      ).toBe(action);
    for (const args of [
      ["--enroll"],
      ["--revoke", "--confirm-world", "lw-dev-gateway-001", "--confirm-database", database],
      ["--enroll", "--confirm-world", world, "--confirm-database", "living_world"],
      ["--delete"],
    ])
      expect(() => parsePilotPlayerArguments(args)).toThrow();
  });

  it("requires private test human ID and the exact isolated pilot route", () => {
    expect(validatePilotPlayerEnvironment(env)).toEqual({
      route: {
        guildId: env.LW_DEV_GUILD_ID,
        channelId: env.LW_PILOT_PARENT_CHANNEL_ID,
        threadId: env.LW_PILOT_THREAD_ID,
      },
      userId: env.LW_PILOT_TEST_USER_ID,
    });
    for (const changes of [
      { LW_PILOT_TEST_USER_ID: "" },
      { LW_PILOT_TEST_USER_ID: "invalid" },
      { LW_PILOT_TEST_USER_ID: "1566909036899868712" },
      { LW_PILOT_TEST_USER_ID: env.LW_DEV_GUILD_ID },
      { LW_PILOT_TEST_USER_ID: env.LW_PILOT_PARENT_CHANNEL_ID },
      { LW_PILOT_TEST_USER_ID: env.LW_PILOT_THREAD_ID },
      { LW_PILOT_PARENT_CHANNEL_ID: env.LW_DEV_PARENT_CHANNEL_ID },
      { LW_PILOT_GUILD_ID: "9999999999999999999" },
      { DATABASE_URL: env.DATABASE_URL?.replace("55432", "5432") },
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { NODE_ENV: "production" },
    ]) {
      expect(() =>
        validatePilotPlayerEnvironment({ ...env, ...changes }),
      ).toThrow();
    }
  });

  it("rejects privileged/wrong database before attempting any enrollment", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{
        database: database,
        db_role: "postgres",
        version: 170003,
        superuser: true,
      }],
    });
    const innerTransaction = vi.fn();
    const transaction = vi.fn().mockImplementation(async (
      callback: (tx: { execute: typeof execute; transaction: typeof innerTransaction }) => Promise<unknown>,
    ) => callback({ execute, transaction: innerTransaction }));
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockReturnValue({ db: { transaction }, close });
    await expect(
      runPilotPlayerCommand(
        [],
        env,
        connect as unknown as Parameters<typeof runPilotPlayerCommand>[2],
      ),
    ).rejects.toThrow("not approved");
    expect(innerTransaction).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
