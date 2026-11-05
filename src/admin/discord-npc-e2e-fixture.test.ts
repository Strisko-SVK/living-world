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
  it("permits only a fresh parent/thread in the same private DEV guild", () => {
    expect(validateNpcE2eFixtureEnvironment(valid)).toEqual({
      guildId: valid.LW_DEV_GUILD_ID,
      channelId: valid.LW_NPC_E2E_PARENT_CHANNEL_ID,
      threadId: valid.LW_NPC_E2E_THREAD_ID,
    });
    expect(
      validateNpcE2eFixtureEnvironment({
        ...valid,
        LW_NPC_E2E_GUILD_ID: valid.LW_DEV_GUILD_ID,
      }),
    ).toEqual({
      guildId: valid.LW_DEV_GUILD_ID,
      channelId: valid.LW_NPC_E2E_PARENT_CHANNEL_ID,
      threadId: valid.LW_NPC_E2E_THREAD_ID,
    });
  });

  it.each([
    ["original parent", { LW_NPC_E2E_PARENT_CHANNEL_ID: valid.LW_DEV_PARENT_CHANNEL_ID }],
    ["original thread", { LW_NPC_E2E_THREAD_ID: valid.LW_DEV_THREAD_ID }],
    ["pilot parent", { LW_NPC_E2E_PARENT_CHANNEL_ID: valid.LW_PILOT_PARENT_CHANNEL_ID }],
    ["pilot thread", { LW_NPC_E2E_THREAD_ID: valid.LW_PILOT_THREAD_ID }],
    ["crossed parent", { LW_NPC_E2E_THREAD_ID: valid.LW_DEV_PARENT_CHANNEL_ID }],
    ["crossed pilot", { LW_NPC_E2E_PARENT_CHANNEL_ID: valid.LW_PILOT_THREAD_ID }],
    ["same route IDs", { LW_NPC_E2E_THREAD_ID: valid.LW_NPC_E2E_PARENT_CHANNEL_ID }],
    ["guild collision", { LW_NPC_E2E_PARENT_CHANNEL_ID: valid.LW_DEV_GUILD_ID }],
    ["other guild", { LW_NPC_E2E_GUILD_ID: "1966911648701223053" }],
    ["missing parent", { LW_NPC_E2E_PARENT_CHANNEL_ID: undefined }],
    ["missing thread", { LW_NPC_E2E_THREAD_ID: undefined }],
    ["invalid channel", { LW_NPC_E2E_PARENT_CHANNEL_ID: "123" }],
    ["unknown consumed pilot", { LW_PILOT_THREAD_ID: undefined }],
  ])("denies %s before DB access", (_case, changes) => {
    expect(() =>
      validateNpcE2eFixtureEnvironment({ ...valid, ...changes }),
    ).toThrow();
  });

  it.each([
    ["enabled inbound", { DISCORD_ENABLED: "true" }],
    ["enabled outbound", { DISCORD_OUTBOUND_ENABLED: "true" }],
    ["paid provider", { LLM_PROVIDER: "openai" }],
    ["production mode", { NODE_ENV: "production" }],
    ["wrong database", { DATABASE_URL: valid.DATABASE_URL?.replace("gateway_dev", "prod") }],
    ["wrong DB port", { DATABASE_URL: valid.DATABASE_URL?.replace("55432", "5432") }],
    ["wrong DB role", { LW_GATEWAY_DEV_ROLE_PASSWORD: "wrong" }],
    ["remote database", { DATABASE_URL: "postgresql://lw_gateway_dev:x@192.0.2.1:55432/living_world_gateway_dev" }],
    ["URL override", { DATABASE_URL: valid.DATABASE_URL + "?host=192.0.2.1" }],
  ])("fails closed on %s", (_case, changes) => {
    expect(() =>
      validateNpcE2eFixtureEnvironment({ ...valid, ...changes }),
    ).toThrow();
  });

  it("defaults to preview, with explicit world and database apply confirmations", () => {
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
      ["--apply", "--confirm-world", "lw-dev-pilot-001", "--confirm-database", "living_world_gateway_dev"],
      ["--apply", "--confirm-world", npcE2eWorldKey, "--confirm-database", "living_world_prod"],
    ]) {
      expect(() => parseNpcE2eFixtureArguments(args)).toThrow();
    }
  });

  it("preflights the database identity in the provisioning transaction", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          database: "living_world_gateway_dev",
          db_role: "lw_gateway_dev",
          version: 170011,
          superuser: false,
        }],
      });
    const innerTransaction = vi.fn().mockResolvedValue({
      status: "would_create",
      worldKey: npcE2eWorldKey,
    });
    const transaction = vi.fn().mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
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

  it("rejects privileged PostgreSQL sessions before provisioning", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        database: "living_world_gateway_dev",
        db_role: "postgres",
        version: 170011,
        superuser: true,
      }] });
    const innerTransaction = vi.fn();
    const transaction = vi.fn().mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
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

  it("refuses unsafe environment before connecting", async () => {
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
