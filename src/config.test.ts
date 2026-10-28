import { describe, expect, it } from "vitest";
import { getApplicationConfig } from "./config.js";

describe("application configuration", () => {
  it("defaults intake permission to deny and validates an explicit scoped allowlist", () => {
    expect(getApplicationConfig({}).discord.intakeAllowlist).toEqual([]);
    const grants = [
      {
        worldId: "00000000-0000-4000-8000-000000000001",
        contextId: "00000000-0000-4000-8000-000000000002",
        authorId: "000123",
      },
    ];
    expect(
      getApplicationConfig({ DISCORD_INTAKE_ALLOWLIST: JSON.stringify(grants) })
        .discord.intakeAllowlist,
    ).toEqual(grants);
  });
  it.each([
    "not JSON",
    "null",
    "{}",
    "[{}]",
    '[{"worldId":"bad","contextId":"bad","authorId":"secret"}]',
    JSON.stringify([
      {
        worldId: "00000000-0000-4000-8000-000000000001",
        contextId: "00000000-0000-4000-8000-000000000002",
        authorId: "a",
        allowResponse: true,
      },
    ]),
  ])(
    "rejects malformed or broadened grants without logging configuration: %s",
    (DISCORD_INTAKE_ALLOWLIST) => {
      expect(() => getApplicationConfig({ DISCORD_INTAKE_ALLOWLIST })).toThrow(
        "Invalid Discord intake allowlist configuration.",
      );
    },
  );
  it("disables Discord by default", () => {
    expect(getApplicationConfig({}).discord.enabled).toBe(false);
  });
  it("validates enabled credentials without exposing input", () => {
    expect(() => getApplicationConfig({ DISCORD_ENABLED: "true" })).toThrow(
      "DISCORD_TOKEN",
    );
    expect(() =>
      getApplicationConfig({
        DISCORD_ENABLED: "true",
        DISCORD_TOKEN: "secret token",
      }),
    ).toThrow("Invalid application configuration.");
    expect(
      getApplicationConfig({
        DISCORD_ENABLED: "true",
        DISCORD_TOKEN: "test-token",
      }).discord.intents,
    ).toEqual(["Guilds", "GuildMessages", "MessageContent"]);
  });
  it.each(["yes", "1", "TRUE"])(
    "rejects invalid enable flag %s",
    (DISCORD_ENABLED) => {
      expect(() => getApplicationConfig({ DISCORD_ENABLED })).toThrow();
    },
  );
  it.each([
    "Guilds",
    "Guilds,GuildMessages,MessageContent,GuildMembers",
    "Guilds,Guilds,MessageContent",
  ])("requires only the documented gateway intents: %s", (DISCORD_INTENTS) => {
    expect(() => getApplicationConfig({ DISCORD_INTENTS })).toThrow(
      "DISCORD_INTENTS",
    );
  });
});
