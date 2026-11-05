import { describe, expect, it, vi } from "vitest";
import {
  createOfflineSceneHandshake,
  type SceneHandshakeDependencies,
  type SceneInteraction,
  type SceneRequest,
} from "./npc-scene-handshake.js";

const request: SceneRequest = {
  worldId: "11111111-1111-4111-8111-111111111111",
  contextId: "22222222-2222-4222-8222-222222222222",
  sourceMessageId: "1766914338158459090",
  guildId: "1566911648701223053",
  channelId: "1766913668795469934",
  threadId: "1766914038158459090",
  authorId: "1666911648701223053",
};
const npcId = "33333333-3333-4333-8333-333333333333";
const identityId = "44444444-4444-4444-8444-444444444444";
const mappingId = "55555555-5555-4555-8555-555555555555";
const evidenceId = "66666666-6666-4666-8666-666666666666";
const interaction: SceneInteraction = {
  id: "77777777-7777-4777-8777-777777777777",
  worldId: request.worldId,
  contextId: request.contextId,
  npcId,
  speakerEntityId: identityId,
  sourceProvider: "discord",
  sourceMessageId: request.sourceMessageId,
  sourceGuildId: request.guildId,
  sourceChannelId: request.channelId,
  sourceThreadId: request.threadId,
  sourceMappingId: mappingId,
  communicationMode: "unknown",
  localPresenceId: null,
  status: "received",
};

function fixture() {
  const deps: SceneHandshakeDependencies = {
    intake: vi.fn().mockResolvedValue("accepted"),
    received: vi.fn().mockResolvedValue([interaction]),
    presence: vi.fn().mockResolvedValue(evidenceId),
    prepare: vi.fn().mockResolvedValue("prepared"),
    respond: vi.fn().mockResolvedValue("delivered"),
  };
  return { deps, run: createOfflineSceneHandshake(deps) };
}

describe("M2.13B offline scene handshake", () => {
  it("coordinates one authorized event and one fake response", async () => {
    const { deps, run } = fixture();
    expect(await run(request)).toBe("delivered");
    expect(deps.intake).toHaveBeenCalledExactlyOnceWith(request);
    expect(deps.received).toHaveBeenCalledExactlyOnceWith(request);
    expect(deps.presence).toHaveBeenCalledExactlyOnceWith(interaction);
    expect(deps.prepare).toHaveBeenCalledExactlyOnceWith(
      interaction,
      evidenceId,
    );
    expect(deps.respond).toHaveBeenCalledExactlyOnceWith(interaction);
  });

  it("rejects invalid IDs and asserted DM privileges", async () => {
    const { deps, run } = fixture();
    const inputs = [
      { ...request, worldId: "not-uuid" },
      { ...request, sourceMessageId: "not-discord-id" },
      { ...request, guildId: "invalid" },
      { ...request, threadId: "invalid" },
      { ...request, authorId: "invalid" },
      { ...request, claimedDm: true },
    ];
    for (const input of inputs)
      expect(await run(input as SceneRequest)).toBe("invalid_request");
    expect(deps.intake).not.toHaveBeenCalled();
  });

  it.each([
    "unauthorized",
    "unmapped",
    "ambiguous_target",
    "invalid_trigger",
    "event_conflict",
    "error",
  ])("denies intake outcome %s", async (result) => {
    const { deps, run } = fixture();
    vi.mocked(deps.intake).mockResolvedValue(result);
    expect(await run(request)).toBe("intake_denied");
    expect(deps.received).not.toHaveBeenCalled();
    expect(deps.respond).not.toHaveBeenCalled();
  });

  it("rejects duplicates without attempting a second response", async () => {
    const { deps, run } = fixture();
    vi.mocked(deps.intake).mockResolvedValue("duplicate");
    expect(await run(request)).toBe("duplicate");
    expect(deps.received).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.respond).not.toHaveBeenCalled();
  });

  it("rejects zero or multiple interaction records", async () => {
    const { deps, run } = fixture();
    vi.mocked(deps.received).mockResolvedValue([]);
    expect(await run(request)).toBe("ambiguous_event");
    vi.mocked(deps.received).mockResolvedValue([interaction, interaction]);
    expect(await run(request)).toBe("ambiguous_event");
    expect(deps.presence).not.toHaveBeenCalled();
  });

  it("rejects modified source and scene bindings", async () => {
    const mutations: Partial<SceneInteraction>[] = [
      { worldId: "88888888-8888-4888-8888-888888888888" },
      { contextId: "88888888-8888-4888-8888-888888888888" },
      { npcId: "invalid" },
      { sourceProvider: "other" },
      { sourceMessageId: "1866914338158459090" },
      { sourceGuildId: "1966911648701223053" },
      { sourceChannelId: "1966913668795469934" },
      { sourceThreadId: "1966914038158459090" },
      { sourceMappingId: null },
      { sourceMappingId: "bad-uuid" },
      { speakerEntityId: null },
      { communicationMode: "local" },
      { localPresenceId: evidenceId },
      { status: "responded" },
    ];
    for (const mutation of mutations) {
      const { deps, run } = fixture();
      vi.mocked(deps.received).mockResolvedValue([
        { ...interaction, ...mutation },
      ]);
      expect(await run(request)).toBe("invalid_binding");
      expect(deps.presence).not.toHaveBeenCalled();
      expect(deps.respond).not.toHaveBeenCalled();
    }
  });

  it("never invents NPC presence from player text", async () => {
    const { deps, run } = fixture();
    vi.mocked(deps.presence).mockResolvedValue(null);
    expect(await run(request)).toBe("no_presence");
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.respond).not.toHaveBeenCalled();
  });

  it("requires DB presence and policy confirmation", async () => {
    const { deps, run } = fixture();
    vi.mocked(deps.prepare).mockResolvedValue("blocked");
    expect(await run(request)).toBe("presence_denied");
    expect(deps.respond).not.toHaveBeenCalled();
  });

  it("never replays after presence changes", async () => {
    const { deps, run } = fixture();
    vi.mocked(deps.prepare).mockResolvedValue("already_prepared");
    expect(await run(request)).toBe("presence_denied");
    expect(deps.respond).not.toHaveBeenCalled();
  });

  it.each([
    "response_blocked",
    "route_changed",
    "delivery_blocked",
    "delivery_uncertain",
    "delivery_retryable",
  ] as const)("propagates outcome %s", async (status) => {
    const { deps, run } = fixture();
    vi.mocked(deps.respond).mockResolvedValue(status);
    expect(await run(request)).toBe(status);
    expect(deps.respond).toHaveBeenCalledTimes(1);
  });

  it("does not retry or leak dependency errors", async () => {
    const { deps, run } = fixture();
    vi.mocked(deps.respond).mockRejectedValue(
      Error("private DB or provider details"),
    );
    expect(await run(request)).toBe("workflow_uncertain");
    expect(deps.respond).toHaveBeenCalledTimes(1);
  });
});
