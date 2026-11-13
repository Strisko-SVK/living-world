import { describe, expect, it, vi } from "vitest";
import { evaluatePlayerSummon } from "../communication/summon-availability.js";
import {
  classifyPostInboundPreview,
  inspectPostInboundPreviewFacts,
  parsePostInboundPreviewArguments,
  runPostInboundPreviewCommand,
} from "./discord-npc-e2e-response-preview.js";
import type { NpcE2eInboundFactsConfig } from "./discord-npc-e2e-inbound.js";
import {
  npcE2eInboundRoute,
  npcE2eInboundTarget,
} from "./discord-npc-e2e-inbound.js";
import { npcE2eWorldKey } from "./discord-npc-e2e-fixture.js";
import { gatewaySmokeBotId } from "./discord-gateway-smoke.js";

const rolePassword = "b".repeat(64);
const safeEnv: NodeJS.ProcessEnv = {
  LW_GATEWAY_DEV_ADMIN_PASSWORD: "a".repeat(64),
  LW_GATEWAY_DEV_ROLE_PASSWORD: rolePassword,
  DATABASE_URL:
    "postgresql://lw_gateway_dev:" +
    rolePassword +
    "@127.0.0.1:55432/living_world_gateway_dev",
  DISCORD_ENABLED: "false",
  DISCORD_OUTBOUND_ENABLED: "false",
  LLM_PROVIDER: "disabled",
  LW_DEV_GUILD_ID: npcE2eInboundRoute.guildId,
  LW_DEV_PARENT_CHANNEL_ID: "1566913668795469934",
  LW_DEV_THREAD_ID: "1566914038158459090",
  LW_PILOT_PARENT_CHANNEL_ID: "1666913668795469934",
  LW_PILOT_THREAD_ID: "1666914038158459090",
  LW_NPC_E2E_PARENT_CHANNEL_ID: npcE2eInboundRoute.parentId,
  LW_NPC_E2E_THREAD_ID: npcE2eInboundRoute.threadId,
  LW_NPC_E2E_TEST_USER_ID: "1888888888888888888",
};

const facts = {
  worldStatus: "active" as const,
  npcStatus: "active" as const,
  npcLifecycle: "active" as const,
  contextStatus: "active" as const,
  contextType: "scene" as const,
  sceneLocationId: "11111111-1111-4111-8111-111111111111",
  npcLocationId: "11111111-1111-4111-8111-111111111111",
  locationCertainty: "certain" as const,
  stateVersion: 1,
  activity: "unknown" as const,
  perception: "unknown" as const,
  otherScene: "unknown" as const,
};

describe("M2.15B privacy-safe Sentinel reply preview (offline)", () => {
  it("accepts only preview, never an execution or Gateway command", () => {
    expect(parsePostInboundPreviewArguments([])).toBeUndefined();
    expect(parsePostInboundPreviewArguments(["--preview"])).toBeUndefined();
    for (const args of [
      ["--connect"],
      ["--execute"],
      ["--generate"],
      ["--send"],
      ["--preview", "--execute"],
      ["--confirm-world", npcE2eWorldKey],
    ])
      expect(() => parsePostInboundPreviewArguments(args)).toThrow();
  });

  it("does not infer speech permission from pre-existing presence", () => {
    const candidate = classifyPostInboundPreview(
      evaluatePlayerSummon({
        ...facts,
        activity: "free",
        perception: "aware",
        otherScene: "none",
      }),
    );
    expect(candidate).toMatchObject({
      status: "candidate_needs_owner_review",
      availability: "candidate",
      reason: "possible",
      canGenerate: false,
      canSend: false,
      readOnly: true,
    });
    const unknown = classifyPostInboundPreview(evaluatePlayerSummon(facts));
    expect(unknown).toMatchObject({
      status: "needs_availability_review",
      reason: "activity_unknown",
      canGenerate: false,
      canSend: false,
    });
    const delayed = classifyPostInboundPreview(
      evaluatePlayerSummon({ ...facts, activity: "busy" }),
    );
    expect(delayed.status).toBe("delayed");
    const unavailable = classifyPostInboundPreview(
      evaluatePlayerSummon({
        ...facts,
        npcLocationId: "22222222-2222-4222-8222-222222222222",
      }),
    );
    expect(unavailable.status).toBe("not_available");
    for (const preview of [candidate, unknown, delayed, unavailable]) {
      expect(preview.canSend).toBe(false);
      expect(preview.canGenerate).toBe(false);
      expect(JSON.stringify(preview)).not.toContain(facts.sceneLocationId);
    }
  });

  it("blocks unsafe runtime, DB connections and player configuration", async () => {
    const connect = vi.fn();
    const unsafe: NodeJS.ProcessEnv[] = [
      { ...safeEnv, NODE_ENV: "production" },
      { ...safeEnv, DISCORD_ENABLED: "true" },
      { ...safeEnv, DISCORD_OUTBOUND_ENABLED: "true" },
      { ...safeEnv, LLM_PROVIDER: "openai" },
      { ...safeEnv, LW_NPC_E2E_TEST_USER_ID: undefined },
      { ...safeEnv, LW_NPC_E2E_TEST_USER_ID: gatewaySmokeBotId },
      { ...safeEnv, LW_NPC_E2E_THREAD_ID: safeEnv.LW_PILOT_THREAD_ID },
      {
        ...safeEnv,
        DATABASE_URL: safeEnv.DATABASE_URL?.replace("55432", "5432"),
      },
    ];
    for (const env of unsafe) {
      await expect(
        runPostInboundPreviewCommand(
          [],
          env,
          connect as unknown as Parameters<
            typeof runPostInboundPreviewCommand
          >[2],
        ),
      ).rejects.toThrow();
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("sets transaction read-only before DB identity lookup and closes the client", async () => {
    const statements: unknown[] = [];
    const execute = vi.fn(async (statement: unknown) => {
      statements.push(statement);
      return { rows: [] };
    });
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute }),
    );
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockReturnValue({
      db: { transaction },
      close,
    });
    await expect(
      runPostInboundPreviewCommand(
        ["--preview"],
        safeEnv,
        connect as unknown as Parameters<
          typeof runPostInboundPreviewCommand
        >[2],
      ),
    ).rejects.toThrow("isolated DEV database");
    expect(statements).toHaveLength(3);
    expect(transaction).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("never reveals a missing event or malformed source text", async () => {
    const config: NpcE2eInboundFactsConfig = {
      botId: gatewaySmokeBotId,
      guildId: npcE2eInboundRoute.guildId,
      parentId: npcE2eInboundRoute.parentId,
      threadId: npcE2eInboundRoute.threadId,
      playerId: safeEnv.LW_NPC_E2E_TEST_USER_ID!,
      presenceId: npcE2eInboundTarget.presenceId,
      scope: { worldKey: npcE2eWorldKey, ...npcE2eInboundTarget },
    };
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const output = await inspectPostInboundPreviewFacts(
      { select } as unknown as Parameters<
        typeof inspectPostInboundPreviewFacts
      >[0],
      config,
    );
    expect(output).toEqual({
      event: "npc_e2e_response_preview",
      worldKey: npcE2eWorldKey,
      status: "integrity_blocked",
      availability: "not_assessed",
      reason: "integrity_blocked",
      canGenerate: false,
      canSend: false,
      readOnly: true,
    });
    expect(JSON.stringify(output)).not.toContain(config.playerId);
  });
});
