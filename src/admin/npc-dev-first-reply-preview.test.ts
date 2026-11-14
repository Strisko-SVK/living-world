import { describe, expect, it, vi } from "vitest";
import {
  inspectDevFirstReplyFacts,
  parseDevFirstReplyArguments,
  runDevFirstReplyPreview,
  validateDevFirstReplyEnvironment,
  type DevFirstReplyConfig,
} from "./npc-dev-first-reply-preview.js";

const password = "b".repeat(64);
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  LW_GATEWAY_DEV_ADMIN_PASSWORD: "a".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD: password,
  DATABASE_URL:
    "postgresql://lw_gateway_dev:" +
    password +
    "@127.0.0.1:55432/living_world_gateway_dev",
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
  LW_FIRST_REPLY_WORLD_KEY: "lw-dev-first-reply-001",
  LW_DEV_GUILD_ID: "1566911648701223053",
  LW_FIRST_REPLY_GUILD_ID: "1566911648701223053",
  LW_FIRST_REPLY_PARENT_ID: "1888888888888888881",
  LW_FIRST_REPLY_THREAD_ID: "1888888888888888882",
  LW_FIRST_REPLY_PLAYER_ID: "1888888888888888883",
};

const config: DevFirstReplyConfig = {
  worldKey: "lw-dev-first-reply-001",
  guildId: "1566911648701223053",
  channelId: "1888888888888888881",
  threadId: "1888888888888888882",
  playerId: "1888888888888888883",
};

describe("M2.15L real DEV first-reply read-only operator preview", () => {
  it("accepts only empty flags or --preview", () => {
    expect(parseDevFirstReplyArguments([])).toBeUndefined();
    expect(parseDevFirstReplyArguments(["--preview"])).toBeUndefined();
    for (const args of [
      ["--execute"],
      ["--apply"],
      ["--send"],
      ["--preview", "--execute"],
      ["--reset"],
    ])
      expect(() => parseDevFirstReplyArguments(args)).toThrow();
  });

  it("parses a new, isolated route and refuses historically used scenes", () => {
    expect(validateDevFirstReplyEnvironment(env)).toEqual(config);
    const old = {
      ...env,
      LW_NPC_E2E_THREAD_ID: config.threadId,
    };
    expect(() => validateDevFirstReplyEnvironment(old)).toThrow();
    expect(() =>
      validateDevFirstReplyEnvironment({
        ...env,
        LW_FIRST_REPLY_WORLD_KEY: "lw-dev-npc-e2e-001",
      }),
    ).toThrow();
  });

  it.each([
    { DISCORD_ENABLED: "true" },
    { DISCORD_OUTBOUND_ENABLED: "true" },
    { LLM_PROVIDER: "openai" },
    { NODE_ENV: "production" },
    { DATABASE_URL: env.DATABASE_URL!.replace("55432", "5432") },
    { LW_GATEWAY_DEV_ROLE_PASSWORD: "bad" },
    { LW_FIRST_REPLY_GUILD_ID: "1888888888888888999" },
    { LW_FIRST_REPLY_PARENT_ID: env.LW_FIRST_REPLY_GUILD_ID },
    { LW_FIRST_REPLY_THREAD_ID: env.LW_FIRST_REPLY_PARENT_ID },
    { LW_FIRST_REPLY_PLAYER_ID: "1566909036899868712" },
    { LW_FIRST_REPLY_THREAD_ID: "not-a-snowflake" },
  ])(
    "refuses dangerous environment before any database connection %#",
    async (change) => {
      const connect = vi.fn();
      const result = await runDevFirstReplyPreview(
        ["--preview"],
        { ...env, ...change },
        connect as unknown as Parameters<typeof runDevFirstReplyPreview>[2],
      );
      expect(result).toMatchObject({
        status: "blocked",
        reason: "unsafe_environment",
        readOnly: true,
        canSend: false,
      });
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it("sets the real PostgreSQL transaction read only before any identity query", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const transaction = vi.fn(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ execute }),
    );
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(() => ({ db: { transaction }, close }));
    const result = await runDevFirstReplyPreview(
      ["--preview"],
      env,
      connect as unknown as Parameters<typeof runDevFirstReplyPreview>[2],
    );
    expect(result).toMatchObject({
      status: "blocked",
      reason: "database_identity_denied",
      canSend: false,
      wouldSend: false,
    });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(execute.mock.calls[0])).toContain(
      "set transaction read only",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses the execute flag even when database credentials are valid", async () => {
    const connect = vi.fn();
    const result = await runDevFirstReplyPreview(
      ["--execute"],
      env,
      connect as unknown as Parameters<typeof runDevFirstReplyPreview>[2],
    );
    expect(result.reason).toBe("unsafe_environment");
    expect(connect).not.toHaveBeenCalled();
  });

  it("blocks forbidden world keys and malformed scopes before any SQL", async () => {
    const db = { execute: vi.fn() };
    const invalid = [
      { ...config, worldKey: "lw-dev-npc-e2e-001" },
      { ...config, playerId: "forged" },
      { ...config, execute: true },
    ];
    for (const value of invalid) {
      const result = await inspectDevFirstReplyFacts(
        db as unknown as Parameters<typeof inspectDevFirstReplyFacts>[0],
        value,
      );
      expect(result).toMatchObject({
        status: "blocked",
        reason: "unsafe_environment",
        canSend: false,
      });
    }
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("sanitizes any PostgreSQL exception and never leaks private rows", async () => {
    const db = {
      execute: vi
        .fn()
        .mockRejectedValue(Error("private SQL and Discord message contents")),
    };
    const result = await inspectDevFirstReplyFacts(
      db as unknown as Parameters<typeof inspectDevFirstReplyFacts>[0],
      config,
    );
    expect(result).toMatchObject({
      status: "blocked",
      reason: "read_failed",
      canGenerate: false,
      canSend: false,
      wouldSend: false,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("returns only fixed safety verdicts, never a send capability", async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValue({ rows: [{ now_ms: "1800000000000" }] }),
    };
    const result = await inspectDevFirstReplyFacts(
      db as unknown as Parameters<typeof inspectDevFirstReplyFacts>[0],
      config,
    );
    expect(result).toMatchObject({
      status: "blocked",
      readOnly: true,
      canSend: false,
      wouldSend: false,
    });
    expect(result.status).not.toBe("fake_only_candidate");
  });
});
