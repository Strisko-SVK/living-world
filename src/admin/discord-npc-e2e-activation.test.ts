import { describe, expect, it, vi } from "vitest";
import {
  parseNpcE2eActivationArguments,
  runNpcE2eActivationCommand,
  validateNpcE2eActivationEnvironment,
  type NpcE2eIds,
} from "./discord-npc-e2e-activation.js";

const ids: NpcE2eIds = {
  worldId: "e551f23e-2393-4726-af97-828ef3587625",
  contextId: "bd921a22-7abc-4c08-ae55-bd7050d9c4f7",
  npcId: "3f066c82-eb7d-45aa-92dd-08d171a7dc2c",
};
const secret = "b".repeat(64);
const environment: NodeJS.ProcessEnv = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: "a".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD: secret,
  DATABASE_URL:
    "postgresql://lw_gateway_dev:" +
    secret +
    "@127.0.0.1:55432/living_world_gateway_dev",
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
  LW_DEV_GUILD_ID: "1566911648701223053",
  LW_DEV_PARENT_CHANNEL_ID: "1566913668795469934",
  LW_DEV_THREAD_ID: "1566914038158459090",
  LW_PILOT_PARENT_CHANNEL_ID: "1567604837309350030",
  LW_PILOT_THREAD_ID: "1567605016603271208",
  LW_NPC_E2E_PARENT_CHANNEL_ID: "1568349822505717830",
  LW_NPC_E2E_THREAD_ID: "1568350458026786886",
  LW_NPC_E2E_TEST_USER_ID: "1766911648701223053",
};
const flags = (mode: "activate" | "disable", scope: NpcE2eIds = ids) => [
  "--" + mode,
  "--confirm-world",
  "lw-dev-npc-e2e-001",
  "--confirm-world-id",
  scope.worldId,
  "--confirm-context",
  scope.contextId,
  "--confirm-npc",
  scope.npcId,
  "--confirm-database",
  "living_world_gateway_dev",
];

describe("M2.14B isolated, operator-only NPC DEV activation", () => {
  it("defaults to read-only and requires exact activation and disable confirmations", () => {
    expect(parseNpcE2eActivationArguments([])).toEqual({ mode: "preview" });
    expect(parseNpcE2eActivationArguments(["--preview"])).toEqual({
      mode: "preview",
    });
    expect(parseNpcE2eActivationArguments(flags("activate"))).toEqual({
      mode: "activate",
      ids,
    });
    expect(parseNpcE2eActivationArguments(flags("disable"))).toEqual({
      mode: "disable",
      ids,
    });
    for (const bad of [
      ["--activate"],
      ["--apply"],
      ["--connect"],
      ["--send"],
      ["--delete"],
      ["--preview", "--activate"],
      flags("activate").slice(0, -1),
      flags("disable").map((v) =>
        v === "lw-dev-npc-e2e-001" ? "lw-dev-pilot-001" : v,
      ),
      flags("activate").map((v) =>
        v === "living_world_gateway_dev" ? "living_world" : v,
      ),
      flags("activate", { ...ids, npcId: "bad" }),
    ])
      expect(() => parseNpcE2eActivationArguments(bad)).toThrow();
  });

  it("accepts only exact loopback DEV PG17 config with Discord and LLM disabled", () => {
    expect(
      validateNpcE2eActivationEnvironment(environment, "activate"),
    ).toMatchObject({
      route: {
        guildId: environment.LW_DEV_GUILD_ID,
        channelId: environment.LW_NPC_E2E_PARENT_CHANNEL_ID,
        threadId: environment.LW_NPC_E2E_THREAD_ID,
      },
      userId: environment.LW_NPC_E2E_TEST_USER_ID,
    });
    for (const bad of [
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { NODE_ENV: "production" },
      { DATABASE_URL: environment.DATABASE_URL?.replace("55432", "5432") },
      {
        DATABASE_URL: environment.DATABASE_URL?.replace(
          "127.0.0.1",
          "example.com",
        ),
      },
      { LW_GATEWAY_DEV_ROLE_PASSWORD: "wrong" },
      { LW_NPC_E2E_PARENT_CHANNEL_ID: environment.LW_PILOT_PARENT_CHANNEL_ID },
      { LW_NPC_E2E_TEST_USER_ID: "1566909036899868712" },
      { LW_NPC_E2E_TEST_USER_ID: environment.LW_NPC_E2E_THREAD_ID },
      { LW_NPC_E2E_TEST_USER_ID: "bad" },
      { LW_NPC_E2E_TEST_USER_ID: undefined },
    ])
      expect(() =>
        validateNpcE2eActivationEnvironment(
          { ...environment, ...bad },
          "activate",
        ),
      ).toThrow();
  });

  it("allows emergency disable even without the private user identity", () => {
    const env = { ...environment };
    delete env.LW_NPC_E2E_TEST_USER_ID;
    expect(
      validateNpcE2eActivationEnvironment(env, "disable").userId,
    ).toBeUndefined();
  });

  it("rejects wrong DB privileges before invoking activation or any writes", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            database: "living_world_gateway_dev",
            db_role: "postgres",
            version: 170011,
            superuser: true,
            createdb: true,
            createrole: true,
          },
        ],
      });
    const transaction = vi
      .fn()
      .mockImplementation(
        (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
          fn({ execute }),
      );
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockReturnValue({ db: { transaction }, close });
    await expect(
      runNpcE2eActivationCommand(
        flags("activate"),
        environment,
        connect as unknown as Parameters<typeof runNpcE2eActivationCommand>[2],
      ),
    ).rejects.toThrow("isolated DEV database");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(transaction).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects unsafe env and invalid flags before making a DB connection", async () => {
    const connect = vi.fn();
    for (const bad of [
      { DISCORD_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { LW_NPC_E2E_TEST_USER_ID: "bad" },
      { DATABASE_URL: environment.DATABASE_URL?.replace("55432", "5432") },
    ])
      await expect(
        runNpcE2eActivationCommand(
          flags("activate"),
          { ...environment, ...bad },
          connect as unknown as Parameters<
            typeof runNpcE2eActivationCommand
          >[2],
        ),
      ).rejects.toThrow();
    await expect(
      runNpcE2eActivationCommand(
        ["--activate"],
        environment,
        connect as unknown as Parameters<typeof runNpcE2eActivationCommand>[2],
      ),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});
