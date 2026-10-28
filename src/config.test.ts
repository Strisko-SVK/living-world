import { describe, expect, it } from "vitest";
import { getApplicationConfig } from "./config.js";

describe("application configuration", () => {
  it("rejects retired per-player configuration rather than silently accepting grants", () => {
    expect(() =>
      getApplicationConfig({ DISCORD_INTAKE_ALLOWLIST: "[]" }),
    ).toThrow("DISCORD_INTAKE_ALLOWLIST is retired");
    expect(getApplicationConfig({}).discord).not.toHaveProperty(
      "intakeAllowlist",
    );
  });
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
