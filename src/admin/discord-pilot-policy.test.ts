import { describe, expect, it, vi } from "vitest";
import {
  parsePilotPolicyArguments,
  runPilotPolicyCommand,
} from "./discord-pilot-policy.js";

const dbPassword = "b".repeat(64);
const env: NodeJS.ProcessEnv = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: "a".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD: dbPassword,
  DATABASE_URL: `postgresql://lw_gateway_dev:${dbPassword}@127.0.0.1:55432/living_world_gateway_dev`,
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
const context = "3608a56c-2597-4df9-b749-b37b7d7cdace";

describe("Step 13 safe pilot scene policy CLI", () => {
  it("defaults to read-only preview and demands exact world/context/database for writes", () => {
    expect(parsePilotPolicyArguments([])).toEqual({ mode: "preview" });
    expect(parsePilotPolicyArguments(["--preview"])).toEqual({
      mode: "preview",
    });
    for (const mode of ["enable", "disable"] as const)
      expect(
        parsePilotPolicyArguments([
          "--" + mode,
          "--confirm-world",
          "lw-dev-pilot-001",
          "--confirm-context",
          context,
          "--confirm-database",
          "living_world_gateway_dev",
        ]),
      ).toEqual({ mode, confirmedContextId: context });
    for (const args of [
      ["--enable"],
      [
        "--enable",
        "--confirm-world",
        "lw-dev-gateway-001",
        "--confirm-context",
        context,
        "--confirm-database",
        "living_world_gateway_dev",
      ],
      [
        "--disable",
        "--confirm-world",
        "lw-dev-pilot-001",
        "--confirm-context",
        "invalid",
        "--confirm-database",
        "living_world_gateway_dev",
      ],
      [
        "--enable",
        "--confirm-world",
        "lw-dev-pilot-001",
        "--confirm-context",
        context,
        "--confirm-database",
        "production",
      ],
    ]) {
      expect(() => parsePilotPolicyArguments(args)).toThrow();
    }
  });

  it("permits emergency disable without a private player env value", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ database: "other", db_role: "postgres", version: 170000, superuser: true }],
    });
    const transaction = vi.fn().mockImplementation(
      async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) =>
        callback({ execute }),
    );
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockReturnValue({ db: { transaction }, close });
    const missingUser = { ...env };
    delete missingUser.LW_PILOT_TEST_USER_ID;
    await expect(
      runPilotPolicyCommand(
        [
          "--disable",
          "--confirm-world",
          "lw-dev-pilot-001",
          "--confirm-context",
          context,
          "--confirm-database",
          "living_world_gateway_dev",
        ],
        missingUser,
        connect as unknown as Parameters<typeof runPilotPolicyCommand>[2],
      ),
    ).rejects.toThrow("not approved");
    expect(execute).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();

    // Only enable needs a private approved human identity.
    await expect(
      runPilotPolicyCommand(
        [
          "--enable",
          "--confirm-world",
          "lw-dev-pilot-001",
          "--confirm-context",
          context,
          "--confirm-database",
          "living_world_gateway_dev",
        ],
        missingUser,
        connect as unknown as Parameters<typeof runPilotPolicyCommand>[2],
      ),
    ).rejects.toThrow("test user");
  });

  it("rejects unsafe runtime or route before database connection", async () => {
    const connect = vi.fn();
    for (const changes of [
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { LW_PILOT_PARENT_CHANNEL_ID: env.LW_DEV_PARENT_CHANNEL_ID },
      { DATABASE_URL: env.DATABASE_URL?.replace("55432", "5432") },
      { NODE_ENV: "production" },
    ]) {
      await expect(
        runPilotPolicyCommand(
          ["--preview"],
          { ...env, ...changes },
          connect as unknown as Parameters<typeof runPilotPolicyCommand>[2],
        ),
      ).rejects.toThrow();
    }
    expect(connect).not.toHaveBeenCalled();
  });
});
