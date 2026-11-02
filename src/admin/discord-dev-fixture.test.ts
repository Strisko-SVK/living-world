import { describe, expect, it } from "vitest";
import {
  parseDevFixtureArguments,
  validateDevFixtureEnvironment,
  devWorldKey,
} from "./discord-dev-fixture.js";

const valid = {
  DATABASE_URL:
    "postgresql://fixture:password@127.0.0.1:5432/living_world_gateway_dev",
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
  LW_DEV_GUILD_ID: "1566911648701223053",
  LW_DEV_PARENT_CHANNEL_ID: "1566913668795469934",
  LW_DEV_THREAD_ID: "1566914038158459090",
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
      "postgresql://local@db.example.com/living_world_gateway_dev",
      "postgresql://local@127.0.0.1/living_world",
      "postgresql://local@127.0.0.1/living_world_gateway_dev?sslmode=require",
      "file:///tmp/living_world_gateway_dev",
      "postgresql://local@127.0.0.1/living_world_gateway_dev#fragment",
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
});
