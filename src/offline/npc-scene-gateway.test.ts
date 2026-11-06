import { describe, expect, it, vi } from "vitest";
import {
  createOfflineGatewaySceneBridge,
  type OfflineGatewaySceneDependencies,
} from "./npc-scene-gateway.js";
import type { IncomingMessage } from "../intake/discord-intake.js";
import type { SceneInteraction } from "./npc-scene-handshake.js";

const message: IncomingMessage = {
  sourceMessageId: "1766914338158459090",
  authorId: "1666911648701223053",
  guildId: "1566911648701223053",
  channelId: "1766913668795469934",
  threadId: "1766914038158459090",
  content: "<@1566909036899868712> [Pelo] Hello.",
  mentionedUserIds: ["1566909036899868712"],
};
const botId = "1566909036899868712";
const scope = {
  worldId: "11111111-1111-4111-8111-111111111111",
  contextId: "22222222-2222-4222-8222-222222222222",
};
const interaction: SceneInteraction = {
  id: "77777777-7777-4777-8777-777777777777",
  ...scope,
  npcId: "33333333-3333-4333-8333-333333333333",
  speakerEntityId: "44444444-4444-4444-8444-444444444444",
  sourceProvider: "discord",
  sourceMessageId: message.sourceMessageId,
  sourceGuildId: message.guildId,
  sourceChannelId: message.channelId,
  sourceThreadId: message.threadId,
  sourceMappingId: "55555555-5555-4555-8555-555555555555",
  communicationMode: "unknown",
  localPresenceId: null,
  status: "received",
};

function fixture() {
  const ports: OfflineGatewaySceneDependencies = {
    resolveScene: vi.fn().mockResolvedValue(scope),
    intake: vi.fn().mockResolvedValue("accepted"),
    received: vi.fn().mockResolvedValue([interaction]),
    presence: vi.fn().mockResolvedValue("66666666-6666-4666-8666-666666666666"),
    prepare: vi.fn().mockResolvedValue("prepared"),
    respond: vi.fn().mockResolvedValue("delivered"),
  };
  return { ports, run: createOfflineGatewaySceneBridge(ports) };
}

describe("M2.13B offline authenticated-Gateway bridge", () => {
  it("derives the request only from the normalized SDK message and resolved scene", async () => {
    const { ports, run } = fixture();
    expect(await run(message, botId)).toBe("delivered");
    expect(ports.resolveScene).toHaveBeenCalledExactlyOnceWith(message);
    expect(ports.intake).toHaveBeenCalledExactlyOnceWith(message, botId);
    expect(ports.respond).toHaveBeenCalledExactlyOnceWith(interaction);
  });

  it("rejects a spoofed bot mention without invoking DB intake", async () => {
    const { ports, run } = fixture();
    expect(await run(message, "1666911648701223053")).toBe("intake_denied");
    expect(ports.resolveScene).not.toHaveBeenCalled();
    expect(ports.intake).not.toHaveBeenCalled();
  });

  it("rejects a nonliteral or absent mention of the authenticated bot", async () => {
    const { ports, run } = fixture();
    expect(
      await run({ ...message, mentionedUserIds: [] }, botId),
    ).toBe("intake_denied");
    expect(
      await run({ ...message, content: "<@1666911648701223053> [Pelo] Hello." }, botId),
    ).toBe("intake_denied");
    expect(ports.intake).not.toHaveBeenCalled();
  });

  it("rejects asserted world, context and DM flags in the event envelope", async () => {
    const { ports, run } = fixture();
    expect(
      await run({ ...message, worldId: scope.worldId, isDm: true } as IncomingMessage, botId),
    ).toBe("delivered");
    expect(ports.intake).toHaveBeenCalledWith(message, botId);
    expect(ports.resolveScene).toHaveBeenCalledWith(message);
  });

  it("fails closed on ambiguous, invalid or failing scene lookups", async () => {
    const { ports, run } = fixture();
    vi.mocked(ports.resolveScene).mockResolvedValue(null);
    expect(await run(message, botId)).toBe("intake_denied");
    vi.mocked(ports.resolveScene).mockResolvedValue({ ...scope, dm: true });
    expect(await run(message, botId)).toBe("intake_denied");
    vi.mocked(ports.resolveScene).mockRejectedValue(Error("private"));
    expect(await run(message, botId)).toBe("intake_denied");
    expect(ports.intake).not.toHaveBeenCalled();
  });

  it("rejects malformed Discord event IDs before invoking intake", async () => {
    const { ports, run } = fixture();
    expect(
      await run({ ...message, sourceMessageId: "not-discord-id" }, botId),
    ).toBe("invalid_request");
    expect(ports.intake).not.toHaveBeenCalled();
  });

  it("does not bypass DB denial or try fake delivery twice", async () => {
    const { ports, run } = fixture();
    vi.mocked(ports.intake).mockResolvedValue("unauthorized");
    expect(await run(message, botId)).toBe("intake_denied");
    expect(ports.respond).not.toHaveBeenCalled();
  });
});
