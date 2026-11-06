import { EventEmitter } from "node:events";
import {
  ChannelType,
  Client,
  Events,
  MessageType,
  type Message,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  connectOnePilotMessage,
  pickPilotInboundMessage,
  type PilotInboundConfig,
  type PilotInboundDiagnosticStage,
} from "./discord-pilot-gateway.js";

const guildId = "1566911648701223053";
const parentId = "1568349822505717830";
const threadId = "1568350458026786886";
const humanId = "1766911648701223053";
const botId = "1566909036899868712";
const token = "fake-private-token-never-used";
const config: PilotInboundConfig = {
  guildId,
  parentId,
  threadId,
  playerId: humanId,
  botId,
  token,
  scope: {
    worldKey: "lw-dev-npc-e2e-001",
    worldId: "e551f23e-2393-4726-af97-828ef3587625",
    contextId: "bd921a22-7abc-4c08-ae55-bd7050d9c4f7",
    npcId: "3f066c82-eb7d-45aa-92dd-08d171a7dc2c",
    playerMappingId: "776190c1-903f-4a73-a9b3-1c799c4043c7",
    policyAuditId: "c87c3ee2-1e2b-438a-9a36-b60299db615b",
  },
};

function testMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    partial: false,
    author: { id: humanId, bot: false },
    webhookId: null,
    system: false,
    guildId,
    channelId: threadId,
    id: "1888888888888888888",
    type: MessageType.Default,
    content: "<@" + botId + "> [Sentinel] Report readiness.",
    channel: {
      type: ChannelType.PublicThread,
      isThread: () => true,
      parentId,
      send: vi.fn(),
    },
    mentions: { users: new Map([[botId, { id: botId }]]) },
    reply: vi.fn(),
    ...overrides,
  } as unknown as Message;
}

function fakeClient() {
  return Object.assign(new EventEmitter(), {
    user: { id: botId },
    guilds: { cache: new Map([[guildId, {}]]) },
    login: vi.fn().mockResolvedValue("fake-connected"),
    destroy: vi.fn().mockResolvedValue(undefined),
  });
}

describe("M2.14D safe one-shot Gateway diagnostics, entirely offline", () => {
  it("classifies only exact-scope events, no data from other channels", () => {
    const stages: PilotInboundDiagnosticStage[] = [];
    const emit = (stage: PilotInboundDiagnosticStage) => stages.push(stage);
    expect(
      pickPilotInboundMessage(
        testMessage({ channelId: parentId }),
        config,
        emit,
      ),
    ).toBeNull();
    expect(
      pickPilotInboundMessage(
        testMessage({ guildId: "1666666666666666666" }),
        config,
        emit,
      ),
    ).toBeNull();
    expect(stages).toEqual([]);

    const cases: {
      overrides: Record<string, unknown>;
      reason: PilotInboundDiagnosticStage;
    }[] = [
      {
        overrides: {
          channel: {
            type: ChannelType.PrivateThread,
            isThread: () => true,
            parentId,
          },
        },
        reason: "thread_shape_rejected",
      },
      {
        overrides: { author: { id: "1999999999999999999", bot: false } },
        reason: "sender_or_kind_rejected",
      },
      {
        overrides: { mentions: { users: new Map() } },
        reason: "mention_rejected",
      },
      {
        overrides: { content: "<@" + botId + "> [Sentinel] Different text." },
        reason: "exact_text_rejected",
      },
    ];
    for (const test of cases) {
      stages.length = 0;
      expect(
        pickPilotInboundMessage(testMessage(test.overrides), config, emit),
      ).toBeNull();
      expect(stages).toEqual(["target_thread_event_seen", test.reason]);
    }
    stages.length = 0;
    expect(pickPilotInboundMessage(testMessage(), config, emit)).not.toBeNull();
    expect(stages).toEqual(["target_thread_event_seen", "message_matched"]);
    const printed = JSON.stringify(stages);
    expect(printed).not.toContain(humanId);
    expect(printed).not.toContain(token);
  });

  it("explains failed normalization without printing message fields", () => {
    const stages: PilotInboundDiagnosticStage[] = [];
    const observe = (stage: PilotInboundDiagnosticStage) => stages.push(stage);
    expect(
      pickPilotInboundMessage(testMessage({ content: "" }), config, observe),
    ).toBeNull();
    expect(stages).toEqual([
      "target_thread_event_seen",
      "bot_mention_metadata_present",
      "normalization_content_unavailable",
      "message_normalization_rejected",
    ]);
    stages.length = 0;
    expect(
      pickPilotInboundMessage(
        testMessage({ content: "", mentions: { users: new Map() } }),
        config,
        observe,
      ),
    ).toBeNull();
    expect(stages).toEqual([
      "target_thread_event_seen",
      "bot_mention_metadata_absent",
      "normalization_content_unavailable",
      "message_normalization_rejected",
    ]);
    stages.length = 0;
    expect(
      pickPilotInboundMessage(testMessage({ id: "bad id" }), config, observe),
    ).toBeNull();
    expect(stages).toEqual([
      "target_thread_event_seen",
      "normalization_source_message_id_invalid",
      "message_normalization_rejected",
    ]);
    const output = JSON.stringify(stages);
    expect(output).not.toContain(humanId);
    expect(output).not.toContain(botId);
    expect(output).not.toContain(token);
    expect(output).not.toContain("bad id");
  });

  it("differentiates filtered thread events from timeout with no matching message", async () => {
    const client = fakeClient();
    const stages: PilotInboundDiagnosticStage[] = [];
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const running = connectOnePilotMessage(
        config,
        vi.fn(),
        vi.fn(),
        client as unknown as Client,
        10,
        (stage) => stages.push(stage),
      );
      await Promise.resolve();
      client.emit(Events.ClientReady);
      client.emit(
        Events.MessageCreate,
        testMessage({ content: "not a mention" }),
      );
      await expect(running).rejects.toThrow("expired");
      expect(stages).toEqual([
        "target_thread_event_seen",
        "mention_rejected",
        "timeout_without_match",
      ]);
      expect(client.destroy).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain(token);
      expect(JSON.stringify(log.mock.calls)).not.toContain(humanId);
    } finally {
      log.mockRestore();
    }
  });

  it("reproduces the observed live failure without revealing any message fields", async () => {
    const client = fakeClient();
    const stages: PilotInboundDiagnosticStage[] = [];
    const intake = vi.fn();
    const audit = vi.fn();
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const running = connectOnePilotMessage(
        config,
        intake,
        audit,
        client as unknown as Client,
        10,
        (stage) => stages.push(stage),
      );
      await Promise.resolve();
      client.emit(Events.ClientReady);
      client.emit(Events.MessageCreate, testMessage({ content: "" }));
      await expect(running).rejects.toThrow("expired");
      expect(stages).toEqual([
        "target_thread_event_seen",
        "bot_mention_metadata_present",
        "normalization_content_unavailable",
        "message_normalization_rejected",
        "timeout_without_match",
      ]);
      expect(intake).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      expect(client.destroy).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain(token);
      expect(JSON.stringify(stages)).not.toContain(humanId);
    } finally {
      log.mockRestore();
    }
  });

  it("distinguishes rejected intake from failed post-write audit", async () => {
    for (const reason of ["intake", "audit"] as const) {
      const client = fakeClient();
      const stages: PilotInboundDiagnosticStage[] = [];
      const intake = vi
        .fn()
        .mockResolvedValue(reason === "intake" ? "unauthorized" : "accepted");
      const audit = vi.fn().mockImplementation(async () => {
        if (reason === "audit") throw new Error("sensitive DB error");
      });
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const running = connectOnePilotMessage(
          config,
          intake,
          audit,
          client as unknown as Client,
          500,
          (stage) => stages.push(stage),
        );
        await Promise.resolve();
        client.emit(Events.ClientReady);
        client.emit(Events.MessageCreate, testMessage());
        await expect(running).rejects.toThrow(
          reason === "intake" ? "not accepted" : "post-write audit failed",
        );
        expect(stages).toEqual(
          reason === "intake"
            ? ["target_thread_event_seen", "message_matched", "intake_rejected"]
            : [
                "target_thread_event_seen",
                "message_matched",
                "intake_accepted",
                "post_write_audit_failed",
              ],
        );
        expect(client.destroy).toHaveBeenCalledOnce();
        const printed = JSON.stringify(log.mock.calls);
        expect(printed).not.toContain(token);
        expect(printed).not.toContain(humanId);
        expect(printed).not.toContain("sensitive DB error");
      } finally {
        log.mockRestore();
      }
    }
  });
});
