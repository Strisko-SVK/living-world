import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { firstReplyWorldKey } from "./dev-first-reply-provision.js";
import {
  parseFirstReplySessionArguments,
  runFirstReplySessionCommand,
  validateFirstReplySessionEnvironment,
} from "./dev-first-reply-session.js";

const route = {
  guildId: "1777777777777777701",
  channelId: "1777777777777777702",
  threadId: "1777777777777777703",
};
const sourceId = "1888888888888888005";
const secret = "a".repeat(64);
const env: NodeJS.ProcessEnv = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: "b".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD: secret,
  DATABASE_URL:
    "postgresql://lw_gateway_dev:" +
    secret +
    "@127.0.0.1:55432/living_world_gateway_dev",
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
  DISCORD_TOKEN: "synthetic_not_real_token_0123456789",
  LW_DEV_BOT_USER_ID: "1566909036899868712",
  LW_DEV_GUILD_ID: route.guildId,
  LW_DEV_PARENT_CHANNEL_ID: "1777777777777777711",
  LW_DEV_THREAD_ID: "1777777777777777712",
  LW_PILOT_PARENT_CHANNEL_ID: "1777777777777777713",
  LW_PILOT_THREAD_ID: "1777777777777777714",
  LW_NPC_E2E_PARENT_CHANNEL_ID: "1777777777777777715",
  LW_NPC_E2E_THREAD_ID: "1777777777777777716",
  LW_FIRST_REPLY_PREVIOUS_PARENT_ID: "1777777777777777717",
  LW_FIRST_REPLY_PREVIOUS_THREAD_ID: "1777777777777777718",
  LW_FIRST_REPLY_WORLD_KEY: firstReplyWorldKey,
  LW_FIRST_REPLY_GUILD_ID: route.guildId,
  LW_FIRST_REPLY_PARENT_ID: route.channelId,
  LW_FIRST_REPLY_THREAD_ID: route.threadId,
  LW_FIRST_REPLY_PLAYER_ID: "1777777777777777755",
  LW_FIRST_REPLY_GATEWAY_APPROVED: "true",
  LW_FIRST_REPLY_SEND_APPROVED: "true",
  LW_FIRST_REPLY_SESSION_APPROVED: "true",
};

const flags = [
  "--run",
  "--confirm-world",
  firstReplyWorldKey,
  "--confirm-guild",
  route.guildId,
  "--confirm-parent",
  route.channelId,
  "--confirm-thread",
  route.threadId,
  "--confirm-database",
  "living_world_gateway_dev",
  "--one-inbound",
  "--one-reply",
  "--no-retry",
];

const dirs: string[] = [];
async function operatorConfig() {
  const dir = await mkdtemp(join(tmpdir(), "lw-m2-15p-operator-"));
  dirs.push(dir);
  const path = join(dir, "key");
  await writeFile(path, "a".repeat(64) + "\n", { mode: 0o600 });
  return {
    ...env,
    LW_FIRST_REPLY_OPERATOR_KEY_PATH: path,
    LW_FIRST_REPLY_OPERATOR_UID: String(process.getuid?.()),
  };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("M2.15P one-session, no-retry first-reply cutover", () => {
  it("accepts only the fully scoped operator command", () => {
    expect(parseFirstReplySessionArguments(flags, route)).toBeUndefined();
    for (const bad of [
      [],
      ["--run"],
      [...flags, "--force"],
      flags.slice(0, -1),
      flags.map((x) =>
        x === firstReplyWorldKey ? "lw-dev-first-reply-001" : x,
      ),
      flags.map((x) => (x === route.threadId ? "1777777777777777799" : x)),
      flags.map((x) => (x === "--no-retry" ? "--retry" : x)),
    ])
      expect(() => parseFirstReplySessionArguments(bad, route)).toThrow();
  });

  it("requires approvals, route isolation and disabled runtime", () => {
    expect(validateFirstReplySessionEnvironment(env)).toEqual(route);
    for (const bad of [
      { LW_FIRST_REPLY_SESSION_APPROVED: undefined },
      { LW_FIRST_REPLY_SEND_APPROVED: undefined },
      { LW_FIRST_REPLY_GATEWAY_APPROVED: undefined },
      { LW_FIRST_REPLY_PRIVILEGED_CONTENT_APPROVED: "true" },
      { LW_FIRST_REPLY_PREVIOUS_PARENT_ID: undefined },
      { LW_FIRST_REPLY_PARENT_ID: env.LW_FIRST_REPLY_PREVIOUS_PARENT_ID },
      { DISCORD_ENABLED: "true" },
      { DISCORD_OUTBOUND_ENABLED: "true" },
      { LLM_PROVIDER: "openai" },
      { NODE_ENV: "production" },
    ])
      expect(() =>
        validateFirstReplySessionEnvironment({ ...env, ...bad }),
      ).toThrow();
  });

  it("blocks absent local operator key", async () => {
    const inbound = vi.fn();
    const send = vi.fn();
    expect(
      await runFirstReplySessionCommand(flags, env, {
        interactive: () => true,
        inbound,
        send,
      }),
    ).toMatchObject({ status: "blocked", attempted: false });
    expect(inbound).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends once after one fresh SDK inbound", async () => {
    const scopedEnv = await operatorConfig();
    const inbound = vi
      .fn()
      .mockResolvedValueOnce({
        event: "npc_first_reply_inbound",
        status: "ready",
        canSend: false,
      })
      .mockResolvedValueOnce({
        event: "npc_first_reply_inbound",
        status: "received",
        canSend: false,
      });
    const load = vi.fn().mockResolvedValue(sourceId);
    const send = vi.fn().mockResolvedValue({
      event: "npc_first_reply_send",
      status: "acknowledged",
      attempted: true,
      canRetry: false,
      canGenerate: false,
      fixedReply: "Acknowledged. Standing by.",
    });
    expect(
      await runFirstReplySessionCommand(flags, scopedEnv, {
        interactive: () => true,
        inbound,
        load,
        send,
      }),
    ).toMatchObject({
      status: "acknowledged",
      attempted: true,
      canRetry: false,
    });
    expect(inbound).toHaveBeenCalledTimes(2);
    expect(inbound.mock.calls[1]?.[0]).toEqual([
      "--connect",
      "--confirm-world",
      firstReplyWorldKey,
      "--confirm-guild",
      route.guildId,
      "--confirm-parent",
      route.channelId,
      "--confirm-thread",
      route.threadId,
      "--confirm-database",
      "living_world_gateway_dev",
      "--inbound-only",
      "--one-message",
    ]);
    expect(load).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    const args = send.mock.calls[0]?.[0] as string[];
    expect(args).toContain(sourceId);
    expect(args).toContain("--one-shot");
    expect(args).toContain("--no-retry");
    expect(args).toContain("Acknowledged. Standing by.");
    expect(args).not.toContain("lw-dev-first-reply-001");
  });

  it("blocks absent or stale received sources", async () => {
    const scopedEnv = await operatorConfig();
    const inbound = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ready",
      })
      .mockResolvedValueOnce({
        status: "received",
      });
    const send = vi.fn();
    const result = await runFirstReplySessionCommand(flags, scopedEnv, {
      interactive: () => true,
      inbound,
      load: async () => null,
      send,
    });
    expect(result).toMatchObject({ status: "blocked", attempted: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not retry failed or uncertain send", async () => {
    const scopedEnv = await operatorConfig();
    const inbound = vi
      .fn()
      .mockResolvedValueOnce({ status: "ready" })
      .mockResolvedValueOnce({ status: "received" });
    const send = vi.fn().mockRejectedValue(new Error("lost ACK"));
    const result = await runFirstReplySessionCommand(flags, scopedEnv, {
      interactive: () => true,
      inbound,
      load: async () => sourceId,
      send,
    });
    expect(result).toMatchObject({
      status: "uncertain",
      attempted: true,
      canRetry: false,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("requires an interactive terminal", async () => {
    const scopedEnv = await operatorConfig();
    const inbound = vi.fn();
    const result = await runFirstReplySessionCommand(flags, scopedEnv, {
      interactive: () => false,
      inbound,
    });
    expect(result.status).toBe("blocked");
    expect(inbound).not.toHaveBeenCalled();
  });
});
