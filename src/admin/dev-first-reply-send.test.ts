import { describe, expect, it, vi } from "vitest";
import {
  parseFirstReplySendArguments,
  runFirstReplySendCommand,
} from "./dev-first-reply-send.js";

const route = {
  guildId: "1777777777777777701",
  channelId: "1777777777777777702",
  threadId: "1777777777777777703",
};
const sourceId = "1888888888888888999";
const fixed = "Acknowledged. Standing by.";
const flags = [
  "--send",
  "--confirm-world",
  "lw-dev-first-reply-001",
  "--confirm-guild",
  route.guildId,
  "--confirm-parent",
  route.channelId,
  "--confirm-thread",
  route.threadId,
  "--confirm-database",
  "living_world_gateway_dev",
  "--confirm-source",
  sourceId,
  "--confirm-reply",
  fixed,
  "--one-shot",
  "--no-retry",
];

describe("M2.15O independent owner-controlled fixed send CLI", () => {
  it("defaults to preview and accepts only the exact irreversible one-shot flags", () => {
    expect(parseFirstReplySendArguments([], route)).toEqual({
      mode: "preview",
    });
    expect(parseFirstReplySendArguments(["--preview"], route)).toEqual({
      mode: "preview",
    });
    expect(parseFirstReplySendArguments(flags, route)).toEqual({
      mode: "send",
      sourceMessageId: sourceId,
    });
    for (const bad of [
      ["--send"],
      ["--connect"],
      ["--retry"],
      ["--approve"],
      flags.slice(0, -1),
      flags.map((value) => (value === fixed ? "Unapproved text." : value)),
      flags.map((value) =>
        value === route.threadId ? "1777777777777777799" : value,
      ),
      flags.map((value) =>
        value === "living_world_gateway_dev" ? "living_world" : value,
      ),
      flags.map((value) => (value === sourceId ? "not-a-snowflake" : value)),
    ]) {
      expect(() => parseFirstReplySendArguments(bad, route)).toThrow();
    }
  });

  it("blocks an unsafe local environment before any DB connection or HTTP request", async () => {
    const connect = vi.fn();
    const http = vi.fn();
    const env: NodeJS.ProcessEnv = {
      DISCORD_ENABLED: "false",
      DISCORD_OUTBOUND_ENABLED: "false",
      LLM_PROVIDER: "disabled",
      LW_FIRST_REPLY_WORLD_KEY: "lw-dev-first-reply-001",
      LW_FIRST_REPLY_GUILD_ID: route.guildId,
      LW_FIRST_REPLY_PARENT_ID: route.channelId,
      LW_FIRST_REPLY_THREAD_ID: route.threadId,
      LW_FIRST_REPLY_PLAYER_ID: "1888888888888888005",
      LW_DEV_GUILD_ID: route.guildId,
      LW_DEV_PARENT_CHANNEL_ID: "1777777777777777711",
      LW_DEV_THREAD_ID: "1777777777777777712",
      LW_PILOT_PARENT_CHANNEL_ID: "1777777777777777713",
      LW_PILOT_THREAD_ID: "1777777777777777714",
      LW_NPC_E2E_PARENT_CHANNEL_ID: "1777777777777777715",
      LW_NPC_E2E_THREAD_ID: "1777777777777777716",
    };
    await expect(
      runFirstReplySendCommand(flags, env, {
        connect: connect as never,
        http: http as never,
      }),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });
});
