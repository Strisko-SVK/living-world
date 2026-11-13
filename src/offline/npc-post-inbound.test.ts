import { describe, expect, it, vi } from "vitest";
import {
  createOfflinePersistedContinuation,
  type PersistedContinuationDependencies,
  type PersistedContinuationRequest,
} from "./npc-post-inbound.js";
import type { SceneInteraction, SceneRequest } from "./npc-scene-handshake.js";

const source: SceneRequest = {
  worldId: "11111111-1111-4111-8111-111111111111",
  contextId: "22222222-2222-4222-8222-222222222222",
  sourceMessageId: "1766914338158459090",
  guildId: "1566911648701223053",
  channelId: "1766913668795469934",
  threadId: "1766914038158459090",
  authorId: "1666911648701223053",
};
const npcId = "33333333-3333-4333-8333-333333333333";
const interactionId = "77777777-7777-4777-8777-777777777777";
const evidenceId = "66666666-6666-4666-8666-666666666666";
const request: PersistedContinuationRequest = { source, npcId, interactionId };
const row: SceneInteraction = {
  id: interactionId,
  worldId: source.worldId,
  contextId: source.contextId,
  npcId,
  speakerEntityId: "44444444-4444-4444-8444-444444444444",
  sourceProvider: "discord",
  sourceMessageId: source.sourceMessageId,
  sourceGuildId: source.guildId,
  sourceChannelId: source.channelId,
  sourceThreadId: source.threadId,
  sourceMappingId: "55555555-5555-4555-8555-555555555555",
  communicationMode: "unknown",
  localPresenceId: null,
  status: "received",
};

function fixture() {
  let stored = { ...row };
  const diagnose = vi.fn();
  const deps: PersistedContinuationDependencies = {
    received: vi.fn(async () => [{ ...stored }]),
    authorize: vi.fn(async () => true),
    presence: vi.fn(async () => evidenceId),
    prepare: vi.fn(async () => "prepared"),
    respond: vi.fn(async () => {
      stored = { ...stored, status: "responded" };
      return "delivered";
    }),
    diagnose,
  };
  return {
    deps,
    diagnose,
    run: createOfflinePersistedContinuation(deps),
    setStored: (next: SceneInteraction) => {
      stored = { ...next };
    },
  };
}

describe("M2.15A persisted Discord inbound continuation (offline only)", () => {
  it("resumes exactly one accepted event without a second intake", async () => {
    const { deps, run, diagnose } = fixture();
    expect(await run(request)).toBe("delivered");
    expect(deps.received).toHaveBeenCalledExactlyOnceWith(source);
    expect(deps.authorize).toHaveBeenCalledExactlyOnceWith(row, source);
    expect(deps.presence).toHaveBeenCalledExactlyOnceWith(row);
    expect(deps.prepare).toHaveBeenCalledExactlyOnceWith(row, evidenceId);
    expect(deps.respond).toHaveBeenCalledExactlyOnceWith(row);
    expect(diagnose).toHaveBeenCalledExactlyOnceWith({
      event: "npc_post_inbound",
      outcome: "delivered",
    });
    expect(await run(request)).toBe("invalid_binding");
    expect(deps.respond).toHaveBeenCalledTimes(1);
  });

  it("does not touch dependencies outside the isolated test boundary", async () => {
    const { deps, run } = fixture();
    for (const [name, value] of [
      ["NODE_ENV", "production"],
      ["DISCORD_ENABLED", "true"],
      ["DISCORD_OUTBOUND_ENABLED", "true"],
      ["LLM_PROVIDER", "openai"],
    ] as const) {
      vi.stubEnv(name, value);
      try {
        expect(await run(request)).toBe("offline_only");
      } finally {
        vi.unstubAllEnvs();
      }
    }
    expect(deps.received).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.respond).not.toHaveBeenCalled();
  });

  it("requires exact, strictly validated source and scope", async () => {
    const { deps, run } = fixture();
    const cases = [
      { ...request, worldId: source.worldId },
      { ...request, npcId: "bad-id" },
      { ...request, interactionId: "bad-id" },
      { ...request, source: { ...source, sourceMessageId: "not-a-snowflake" } },
      { ...request, source: { ...source, threadId: "invalid" } },
      { ...request, source: { ...source, isDm: true } },
      { ...request, source: { ...source, authorId: "bot" } },
    ];
    for (const invalid of cases)
      expect(await run(invalid as PersistedContinuationRequest)).toBe(
        "invalid_request",
      );
    expect(deps.received).not.toHaveBeenCalled();
  });

  it("rejects missing and ambiguous immutable source events", async () => {
    const { deps, run } = fixture();
    vi.mocked(deps.received).mockResolvedValueOnce([]);
    expect(await run(request)).toBe("not_found");
    vi.mocked(deps.received).mockResolvedValueOnce([row, row]);
    expect(await run(request)).toBe("ambiguous_event");
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it("refuses foreign-world, scene, NPC, event and altered route bindings", async () => {
    const changes: Partial<SceneInteraction>[] = [
      { id: "88888888-8888-4888-8888-888888888888" },
      { npcId: "88888888-8888-4888-8888-888888888888" },
      { worldId: "88888888-8888-4888-8888-888888888888" },
      { contextId: "88888888-8888-4888-8888-888888888888" },
      { sourceMessageId: "1866914338158459090" },
      { sourceGuildId: "1966911648701223053" },
      { sourceChannelId: "1966913668795469934" },
      { sourceThreadId: "1966914038158459090" },
      { sourceMappingId: null },
      { sourceMappingId: "bad" },
      { sourceProvider: "other" },
      { speakerEntityId: null },
      { speakerEntityId: "bad" },
      { communicationMode: "local" },
      { localPresenceId: evidenceId },
      { status: "responded" },
    ];
    for (const change of changes) {
      const { deps, run, setStored } = fixture();
      setStored({ ...row, ...change });
      expect(await run(request)).toBe("invalid_binding");
      expect(deps.authorize).not.toHaveBeenCalled();
      expect(deps.prepare).not.toHaveBeenCalled();
      expect(deps.respond).not.toHaveBeenCalled();
    }
  });

  it("requires a fresh authoritative author/route authorization", async () => {
    const { deps, run } = fixture();
    vi.mocked(deps.authorize).mockResolvedValue(false);
    expect(await run(request)).toBe("authorization_denied");
    expect(deps.presence).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.respond).not.toHaveBeenCalled();
  });

  it("refuses missing/forged presence and stale or revoked DB preparations", async () => {
    for (const presence of [null, "bad-evidence"]) {
      const { deps, run } = fixture();
      vi.mocked(deps.presence).mockResolvedValue(presence);
      expect(await run(request)).toBe("no_presence");
      expect(deps.prepare).not.toHaveBeenCalled();
      expect(deps.respond).not.toHaveBeenCalled();
    }
    for (const result of ["blocked", "already_prepared", "conflict", "stale"]) {
      const { deps, run } = fixture();
      vi.mocked(deps.prepare).mockResolvedValue(result);
      expect(await run(request)).toBe("presence_denied");
      expect(deps.respond).not.toHaveBeenCalled();
    }
  });

  it("classifies errors without retry or sensitive diagnostic output", async () => {
    const { deps, run, diagnose } = fixture();
    vi.mocked(deps.authorize).mockRejectedValueOnce(
      Error("sensitive mapping details"),
    );
    expect(await run(request)).toBe("authorization_denied");
    vi.mocked(deps.respond).mockRejectedValueOnce(
      Error("sensitive fake transport uncertainty"),
    );
    expect(await run(request)).toBe("workflow_uncertain");
    expect(deps.respond).toHaveBeenCalledTimes(1);
    const output = JSON.stringify(diagnose.mock.calls);
    for (const secret of [
      source.sourceMessageId,
      source.authorId,
      source.guildId,
      "sensitive",
      interactionId,
    ])
      expect(output).not.toContain(secret);
  });

  it("never lets diagnostic failures bypass an authorization denial", async () => {
    const { deps, run } = fixture();
    vi.mocked(deps.authorize).mockResolvedValue(false);
    vi.mocked(deps.diagnose!).mockImplementation(() => {
      throw Error("diagnostic unavailable");
    });
    expect(await run(request)).toBe("authorization_denied");
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it("does not retry a returned uncertain fake delivery", async () => {
    const { deps, run, setStored } = fixture();
    vi.mocked(deps.respond).mockImplementationOnce(async () => {
      setStored({ ...row, status: "responded" });
      return "delivery_uncertain";
    });
    expect(await run(request)).toBe("delivery_uncertain");
    expect(await run(request)).toBe("invalid_binding");
    expect(deps.respond).toHaveBeenCalledTimes(1);
  });
});
