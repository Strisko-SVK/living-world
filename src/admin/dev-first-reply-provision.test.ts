import { describe, expect, it, vi } from "vitest";
import {
  firstReplyWorldKey,
  parseFirstReplyProvisionArguments,
  runFirstReplyProvisionCommand,
  validateFirstReplyProvisionEnvironment,
} from "./dev-first-reply-provision.js";

const route = {
  guildId: "1566911648701223053",
  channelId: "1571156338854076668",
  threadId: "1571156531624288468",
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
  LW_DEV_GUILD_ID: route.guildId,
  LW_DEV_PARENT_CHANNEL_ID: "1566913668795469934",
  LW_DEV_THREAD_ID: "1566914038158459090",
  LW_PILOT_PARENT_CHANNEL_ID: "1567604837309350030",
  LW_PILOT_THREAD_ID: "1567605016603271208",
  LW_NPC_E2E_PARENT_CHANNEL_ID: "1568349822505717830",
  LW_NPC_E2E_THREAD_ID: "1568350458026786886",
  LW_FIRST_REPLY_WORLD_KEY: firstReplyWorldKey,
  LW_FIRST_REPLY_GUILD_ID: route.guildId,
  LW_FIRST_REPLY_PARENT_ID: route.channelId,
  LW_FIRST_REPLY_THREAD_ID: route.threadId,
  LW_FIRST_REPLY_PLAYER_ID: "1766911648701223053",
};

const confirmed = (mode: "prepare" | "disable") => [
  "--" + mode,
  "--confirm-world",
  firstReplyWorldKey,
  "--confirm-parent",
  route.channelId,
  "--confirm-thread",
  route.threadId,
  "--confirm-database",
  "living_world_gateway_dev",
  "--offline-only",
];

describe("M2.15O isolated Sentinel first reply provisioning", () => {
  it("is read-only by default; prepare/disable require the exact route and database", () => {
    expect(parseFirstReplyProvisionArguments([], route)).toBe("preview");
    expect(parseFirstReplyProvisionArguments(["--preview"], route)).toBe(
      "preview",
    );
    expect(parseFirstReplyProvisionArguments(confirmed("prepare"), route)).toBe(
      "prepare",
    );
    expect(parseFirstReplyProvisionArguments(confirmed("disable"), route)).toBe(
      "disable",
    );
    for (const bad of [
      ["--prepare"],
      ["--apply"],
      ["--send"],
      ["--connect"],
      ["--disable"],
      confirmed("prepare").slice(0, -1),
      confirmed("prepare").map((x) =>
        x === route.threadId ? "1568350458026786886" : x,
      ),
      confirmed("disable").map((x) =>
        x === "living_world_gateway_dev" ? "living_world" : x,
      ),
    ])
      expect(() => parseFirstReplyProvisionArguments(bad, route)).toThrow();
  });

  it("checks the exact local DB and rejects old/ambiguous routes", () => {
    expect(validateFirstReplyProvisionEnvironment(environment, "prepare")).toEqual({
      route,
      userId: environment.LW_FIRST_REPLY_PLAYER_ID,
    });
    for (const invalid of [
      { NODE_ENV: "production" },
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { LW_FIRST_REPLY_WORLD_KEY: "lw-dev-npc-e2e-001" },
      { LW_FIRST_REPLY_PARENT_ID: environment.LW_NPC_E2E_PARENT_CHANNEL_ID },
      { LW_FIRST_REPLY_THREAD_ID: environment.LW_PILOT_THREAD_ID },
      { LW_FIRST_REPLY_PARENT_ID: route.threadId },
      { LW_FIRST_REPLY_GUILD_ID: "1111111111111111111" },
      { LW_FIRST_REPLY_PLAYER_ID: "bad" },
      { LW_FIRST_REPLY_PLAYER_ID: "1566909036899868712" },
      { LW_FIRST_REPLY_PLAYER_ID: route.threadId },
      { LW_FIRST_REPLY_PLAYER_ID: undefined },
      { LW_NPC_E2E_PARENT_CHANNEL_ID: undefined },
      { DATABASE_URL: environment.DATABASE_URL?.replace("55432", "5432") },
      {
        DATABASE_URL: environment.DATABASE_URL?.replace(
          "127.0.0.1",
          "example.com",
        ),
      },
    ])
      expect(() =>
        validateFirstReplyProvisionEnvironment(
          { ...environment, ...invalid },
          "prepare",
        ),
      ).toThrow();
  });

  it("emergency disable does not depend on the private player ID", () => {
    for (const userId of [undefined, "invalid"]) {
      expect(
        validateFirstReplyProvisionEnvironment(
          { ...environment, LW_FIRST_REPLY_PLAYER_ID: userId },
          "disable",
        ),
      ).toEqual({ route });
    }
  });

  it("rejects unsafe arguments or environment before connecting", async () => {
    const connect = vi.fn();
    await expect(
      runFirstReplyProvisionCommand(
        ["--send"],
        environment,
        connect as never,
      ),
    ).rejects.toThrow();
    await expect(
      runFirstReplyProvisionCommand(
        confirmed("prepare"),
        { ...environment, LW_FIRST_REPLY_PLAYER_ID: "invalid" },
        connect as never,
      ),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });

  it("enforces an explicit PostgreSQL read-only transaction in preview", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          database: "living_world_gateway_dev",
          db_role: "lw_gateway_dev",
          db_owner: "lw_gateway_dev",
          version: 170000,
          superuser: false,
          createdb: false,
          createrole: false,
          consent_table: "npc_dev_first_reply_consents",
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { tgname: "discord_route_revision" },
          { tgname: "scene_speech_policy_immutable" },
          { tgname: "scene_speech_policy_no_truncate" },
        ],
      });
    const transaction = vi.fn().mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute,
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
    );
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockReturnValue({
      db: { transaction },
      close,
    });
    const result = await runFirstReplyProvisionCommand(
      ["--preview"],
      environment,
      connect as never,
    );
    expect(result).toEqual({
      event: "npc_first_reply_provision",
      status: "fresh_route_candidate",
      worldKey: firstReplyWorldKey,
      canSend: false,
      readOnly: true,
    });
    expect(execute).toHaveBeenCalledTimes(5);
    expect(String(execute.mock.calls[0]?.[0]?.queryChunks?.[0]?.value?.[0] ?? "")).toContain("set transaction read only");
    expect(close).toHaveBeenCalledOnce();
  });
});
