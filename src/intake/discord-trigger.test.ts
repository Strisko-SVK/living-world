import { describe, expect, it, vi } from "vitest";
import { parseDiscordTrigger } from "./discord-trigger.js";
import {
  createDiscordIntake,
  type IncomingMessage,
  type IntakePersistence,
} from "./discord-intake.js";

const message: IncomingMessage = {
  sourceMessageId: "000123",
  authorId: "author",
  guildId: "guild",
  channelId: "channel",
  threadId: null,
  content: "<@123> [ Garak ] Check the manifest.",
  mentionedUserIds: ["123"],
};
function persistence(): IntakePersistence {
  return {
    worldIds: vi.fn(),
    context: vi.fn(),
    identities: vi.fn(),
    isNpc: vi.fn(),
    primaryNpcs: vi.fn(),
    persist: vi.fn().mockResolvedValue("accepted"),
  };
}
describe("explicit Discord trigger grammar", () => {
  it.each([
    "<@123> [Garak] Hello.",
    "<@!123> [Garak] Hello.",
    "  <@123>\t[ GARAK ]  Hello.\n",
    "<@123> [GaRaK] Hello.",
  ])("accepts authenticated mention and normalized alias: %s", (content) => {
    expect(parseDiscordTrigger(content, "123", ["123"])).toEqual({
      alias: "garak",
      body: "Hello.",
    });
  });
  it("collapses alias spaces and leaves body mentions/brackets as data", () => {
    expect(
      parseDiscordTrigger(
        "<@123> [ Great  Garak ] Hello <@456> [Other NPC]",
        "123",
        ["123", "456"],
      ),
    ).toEqual({ alias: "great garak", body: "Hello <@456> [Other NPC]" });
  });
  it.each([
    "@NPC BOT [Garak] Hello.",
    "<@456> [Garak] Hello.",
    "<@&123> [Garak] Hello.",
    "<@123> Hello.",
    "<@123> [] Hello.",
    "<@123> [   ] Hello.",
    "<@123> [[Garak]] Hello.",
    "<@123> [Garak Hello.",
    "<@123> [Garak]",
    "<@123> [Garak]   ",
    "<@123> [Garak] <@456>",
    "<@123>[Garak] Hello.",
    "<@123> [Garak]Hello.",
    "<@123>\n[Garak] Hello.",
    "<@123> [Ga\nrak] Hello.",
    "<@123> [Ga\trak] Hello.",
    "<@123> [Ga\u200brak] Hello.",
    "> <@123> [Garak] Hello.",
    "```<@123> [Garak] Hello.```",
    "prefix <@123> [Garak] Hello.",
    `<@123> [${"x".repeat(201)}] Hello.`,
    `<@123> [Garak] ${"x".repeat(20000)}`,
  ])("rejects invalid grammar: %s", (content) => {
    expect(parseDiscordTrigger(content, "123", ["123", "456"])).toBeNull();
  });
  it.each([undefined, null, "", "not-an-id", "1".repeat(21)])(
    "requires a trustworthy bot identity: %s",
    (bot) => {
      expect(parseDiscordTrigger(message.content, bot, ["123"])).toBeNull();
    },
  );
  it("requires the SDK-confirmed literal mention", () => {
    expect(parseDiscordTrigger(message.content, "123", [])).toBeNull();
  });
});
describe("strict intake default and persistence boundary", () => {
  it("passes only the event and authenticated bot identity to durable routing", async () => {
    const store = persistence(),
      diagnose = vi.fn();
    expect(await createDiscordIntake(store, diagnose)(message, "123")).toBe(
      "accepted",
    );
    expect(store.persist).toHaveBeenCalledWith({
      message,
      traceId: expect.any(String),
      trigger: { botId: "123" },
    });
    expect(store.primaryNpcs).not.toHaveBeenCalled();
    expect(store.identities).not.toHaveBeenCalled();
    expect(store.worldIds).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnose.mock.calls)).not.toContain("manifest");
  });
  it.each([
    "unauthorized",
    "unmapped",
    "ambiguous_world",
    "ambiguous_speaker",
    "ambiguous_target",
    "invalid_target",
    "duplicate",
    "event_conflict",
  ])("preserves durable outcome %s", async (outcome) => {
    const store = persistence();
    vi.mocked(store.persist).mockResolvedValue(outcome);
    expect(await createDiscordIntake(store)(message, "123")).toBe(outcome);
    expect(store.persist).toHaveBeenCalledTimes(1);
  });
  it("has no implicit primary/operator fallback or trust in envelope bot IDs", async () => {
    const store = persistence(),
      run = createDiscordIntake(store);
    expect(await run({ ...message, botId: "123" })).toBe("invalid_trigger");
    expect(await run(message, "456")).toBe("invalid_trigger");
    expect(await run({ ...message, content: "Hello." }, "123")).toBe(
      "invalid_trigger",
    );
    expect(store.persist).not.toHaveBeenCalled();
    expect(store.primaryNpcs).not.toHaveBeenCalled();
  });
  it("isolates database errors without exposing raw details", async () => {
    const store = persistence(),
      diagnose = vi.fn();
    vi.mocked(store.persist).mockRejectedValue(
      Error("private database details"),
    );
    expect(await createDiscordIntake(store, diagnose)(message, "123")).toBe(
      "error",
    );
    expect(JSON.stringify(diagnose.mock.calls)).not.toContain("private");
  });
});
