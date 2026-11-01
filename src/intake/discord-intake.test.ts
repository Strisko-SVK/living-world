import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordIntake as createIntake,
  type IncomingMessage,
  type IntakePersistence,
} from "./discord-intake.js";

// Preserve foundation routing regressions through its explicit compatibility mode.
const createDiscordIntake = (
  ...[persistence, diagnose]: Parameters<typeof createIntake>
) => createIntake(persistence, diagnose, "mapped");

const message: IncomingMessage = {
  sourceMessageId: "000123",
  authorId: "author",
  guildId: "guild",
  channelId: "channel",
  threadId: null,
  content: "Please check the manifest.",
  mentionedUserIds: [],
};
let store: IntakePersistence;
beforeEach(() => {
  store = {
    worldIds: vi.fn().mockResolvedValue(["world"]),
    context: vi
      .fn()
      .mockResolvedValue({ id: "scene", worldId: "world", status: "active" }),
    identities: vi.fn().mockResolvedValue([
      {
        entityId: "speaker",
        mappingType: "player_character",
        isPrimary: true,
      },
    ]),
    isNpc: vi.fn().mockResolvedValue(true),
    primaryNpcs: vi.fn().mockResolvedValue(["npc"]),
    persist: vi.fn().mockResolvedValue(undefined),
  };
});

describe("Discord intake", () => {
  it("persists mapped intake with original scene, source and trace, without transport timestamps", async () => {
    expect(await createDiscordIntake(store)(message)).toBe("accepted");
    expect(store.persist).toHaveBeenCalledWith({
      worldId: "world",
      contextId: "scene",
      speakerEntityId: "speaker",
      npcIds: ["npc"],
      message,
      traceId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(Object.keys(store).sort()).toEqual([
      "context",
      "identities",
      "isNpc",
      "persist",
      "primaryNpcs",
      "worldIds",
    ]);
  });
  it("keeps scene context when targeting an NPC mentioned from another primary space", async () => {
    vi.mocked(store.identities).mockImplementation(async (_world, user) =>
      user === "operator"
        ? [
            {
              entityId: "other-npc",
              mappingType: "npc_operator",
              isPrimary: false,
            },
          ]
        : [],
    );
    expect(
      await createDiscordIntake(store)({
        ...message,
        content: "<@123> hello",
        mentionedUserIds: ["operator"],
      }),
    ).toBe("accepted");
    expect(store.primaryNpcs).not.toHaveBeenCalled();
    expect(store.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: "scene",
        npcIds: ["other-npc"],
        speakerEntityId: null,
      }),
    );
  });
  it("forwards exact thread coordinates to the existing mapping resolver", async () => {
    const threaded = { ...message, threadId: "thread" };
    await createDiscordIntake(store)(threaded);
    expect(store.context).toHaveBeenCalledWith("world", threaded);
  });
  it("permits unknown speakers under the nullable domain speaker contract", async () => {
    vi.mocked(store.identities).mockResolvedValue([]);
    expect(await createDiscordIntake(store)(message)).toBe("accepted");
    expect(store.persist).toHaveBeenCalledWith(
      expect.objectContaining({ speakerEntityId: null }),
    );
  });
  it("rejects ambiguous characters instead of picking an arbitrary identity", async () => {
    vi.mocked(store.identities).mockResolvedValue(
      ["a", "b"].map((entityId) => ({
        entityId,
        mappingType: "player_character",
        isPrimary: false,
      })),
    );
    expect(await createDiscordIntake(store)(message)).toBe("ambiguous_speaker");
    expect(store.persist).not.toHaveBeenCalled();
  });
  it("uses an explicitly primary character among multiple mappings", async () => {
    vi.mocked(store.identities).mockResolvedValue(
      ["a", "b"].map((entityId) => ({
        entityId,
        mappingType: "player_character",
        isPrimary: entityId === "b",
      })),
    );
    expect(await createDiscordIntake(store)(message)).toBe("accepted");
    expect(store.persist).toHaveBeenCalledWith(
      expect.objectContaining({ speakerEntityId: "b" }),
    );
  });
  it.each([{ worlds: [] }, { worlds: ["world", "other-world"] }])(
    "rejects unmapped or ambiguous worlds %j",
    async ({ worlds }) => {
      vi.mocked(store.worldIds).mockResolvedValue(worlds);
      await createDiscordIntake(store)(message);
      expect(store.persist).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { id: "scene", worldId: "other-world", status: "active" },
    { id: "scene", worldId: "world", status: "archived" },
  ])("rejects unavailable or cross-world contexts %j", async (context) => {
    vi.mocked(store.context).mockResolvedValue(context);
    expect(await createDiscordIntake(store)(message)).toBe("unmapped");
    expect(store.persist).not.toHaveBeenCalled();
  });
  it("supports multiple explicit NPC targets and deduplicates repeated mentions", async () => {
    vi.mocked(store.identities).mockImplementation(async (_world, user) =>
      user === "author"
        ? []
        : [{ entityId: user, mappingType: "npc_operator", isPrimary: false }],
    );
    await createDiscordIntake(store)({
      ...message,
      mentionedUserIds: ["npc-b", "npc-a", "npc-b"],
    });
    expect(store.persist).toHaveBeenCalledWith(
      expect.objectContaining({ npcIds: ["npc-a", "npc-b"] }),
    );
  });
  it("rejects ambiguous mention mappings without partial persistence", async () => {
    vi.mocked(store.identities).mockResolvedValue(
      ["a", "b"].map((entityId) => ({
        entityId,
        mappingType: "npc_operator",
        isPrimary: false,
      })),
    );
    expect(
      await createDiscordIntake(store)({
        ...message,
        mentionedUserIds: ["operator"],
      }),
    ).toBe("ambiguous_target");
    expect(store.persist).not.toHaveBeenCalled();
  });
  it.each([{ targets: [] }, { targets: ["a", "b"] }])(
    "ignores absent or ambiguous primary NPCs %j",
    async ({ targets }) => {
      vi.mocked(store.primaryNpcs).mockResolvedValue(targets);
      await createDiscordIntake(store)(message);
      expect(store.persist).not.toHaveBeenCalled();
    },
  );
  it("rejects a target that is not an active NPC in the resolved world", async () => {
    vi.mocked(store.isNpc).mockResolvedValue(false);
    expect(await createDiscordIntake(store)(message)).toBe("invalid_target");
    expect(store.persist).not.toHaveBeenCalled();
  });
  it("does not interpret unrelated user mentions as NPC targeting", async () => {
    expect(
      await createDiscordIntake(store)({
        ...message,
        mentionedUserIds: ["player"],
      }),
    ).toBe("untargeted");
    expect(store.primaryNpcs).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { ...message, content: " " },
    { ...message, sourceMessageId: " " },
  ])("ignores malformed input %j", async (input) => {
    expect(await createDiscordIntake(store)(input)).toBe("unsupported");
    expect(store.worldIds).not.toHaveBeenCalled();
  });
  it("ignores mention-only pings", async () => {
    expect(
      await createDiscordIntake(store)({ ...message, content: "<@123>" }),
    ).toBe("irrelevant");
    expect(store.worldIds).not.toHaveBeenCalled();
  });
  it("delegates repeated and concurrent events to durable persistence", async () => {
    const intake = createDiscordIntake(store);
    await Promise.all([intake(message), intake(message)]);
    await intake(message);
    expect(store.persist).toHaveBeenCalledTimes(3);
    for (const [input] of vi.mocked(store.persist).mock.calls)
      expect(input.message.sourceMessageId).toBe(message.sourceMessageId);
  });
  it.each([
    "worldIds",
    "context",
    "identities",
    "isNpc",
    "primaryNpcs",
    "persist",
  ] as const)(
    "isolates %s errors without logging content or credentials",
    async (method) => {
      vi.mocked(store[method]).mockRejectedValue(
        new Error("secret-token raw message content"),
      );
      const diagnostics = vi.fn();
      expect(await createDiscordIntake(store, diagnostics)(message)).toBe(
        "error",
      );
      expect(diagnostics).toHaveBeenCalledWith({
        event: "discord_intake",
        outcome: "error",
      });
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(
        "secret-token",
      );
    },
  );
});
