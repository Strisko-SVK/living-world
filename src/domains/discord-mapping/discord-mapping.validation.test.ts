import { describe, expect, it } from "vitest";

import {
  discordLocationInputSchema,
  mapDiscordContextInputSchema,
  mapDiscordUserToEntityInputSchema,
} from "./discord-mapping.validation.js";

const entityId = "7d444ea9-18af-4a0e-8a66-1fa7994453df";
const contextId = "90b3c817-7fc6-45e8-92db-779862fef863";

describe("Discord mapping validation", () => {
  it("accepts opaque identity and context mapping inputs", () => {
    expect(
      mapDiscordUserToEntityInputSchema.parse({
        discordUserId: "synthetic-user-1",
        entityId,
        mappingType: "player_character",
      }),
    ).toMatchObject({ status: "active", isPrimary: false });
    expect(
      mapDiscordContextInputSchema.parse({
        contextId,
        guildId: "synthetic-guild-1",
        channelId: "synthetic-channel-1",
        mappingType: "scene",
      }),
    ).toMatchObject({ status: "active" });
  });

  it("rejects empty IDs, invalid types, and invalid UUIDs", () => {
    expect(() =>
      mapDiscordUserToEntityInputSchema.parse({
        discordUserId: " ",
        entityId,
        mappingType: "player_character",
      }),
    ).toThrow();
    expect(() =>
      mapDiscordUserToEntityInputSchema.parse({
        discordUserId: "user",
        entityId,
        mappingType: "character",
      }),
    ).toThrow();
    expect(() =>
      mapDiscordContextInputSchema.parse({
        contextId: "not-a-uuid",
        guildId: "guild",
        channelId: "channel",
        mappingType: "scene",
      }),
    ).toThrow();
    expect(() =>
      mapDiscordContextInputSchema.parse({
        contextId,
        guildId: "guild",
        channelId: " ",
        mappingType: "scene",
      }),
    ).toThrow();
  });

  it("accepts exact thread location input separately from channel input", () => {
    expect(
      discordLocationInputSchema.parse({
        guildId: "guild",
        channelId: "channel",
        threadId: "thread",
      }),
    ).toMatchObject({ threadId: "thread" });
    expect(
      discordLocationInputSchema.parse({
        guildId: "guild",
        channelId: "channel",
      }),
    ).toMatchObject({});
  });
});
