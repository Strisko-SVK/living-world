import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { createRaonDevTurn } from "../admin/raon-dev-turn.js";
import { setupRaonFixture } from "../admin/raon-dev-fixture.js";
import {
  issueHostSceneSpeechPolicy,
  revokeHostSceneSpeechPolicy,
} from "../communication/scene-speech-policies.repository.js";
import type { IncomingMessage } from "../intake/discord-intake.js";
import { createDatabaseClient } from "./client.js";
import { interactions, responseDeliveries } from "./schema/index.js";

const db = createDatabaseClient();
afterAll(() => db.close());
const rollback = new Error("roll back synthetic Raon pilot");

it("runs ten source-bound turns on PostgreSQL, retains delivered context, blocks duplicate/foreign events and never replays uncertain delivery", async () => {
  await expect(
    db.db.transaction(async (tx) => {
      const route = {
        guildId: "1600000000000000010",
        channelId: "1600000000000000011",
        threadId: "1600000000000000012",
      };
      const botId = "1600000000000000013";
      const playerId = "1600000000000000014";
      const worldKey = "npc-gateway-ci-" + randomUUID();
      const fixture = await setupRaonFixture(tx, route, playerId, worldKey);
      expect(await setupRaonFixture(tx, route, playerId, worldKey)).toEqual(
        fixture,
      );
      await expect(
        setupRaonFixture(
          tx,
          { ...route, threadId: playerId },
          playerId,
          worldKey,
        ),
      ).rejects.toThrow();
      const scope = {
        worldId: fixture.worldId,
        contextId: fixture.contextId,
        npcId: fixture.npcId,
        presenceId: fixture.presenceId,
      };
      const policy = await issueHostSceneSpeechPolicy(tx, {
        ...scope,
        decision: "allow_direct_speech",
        activity: "free",
        perception: "aware",
        otherScene: "none",
        ttlMinutes: 30,
        issuerEntityId: fixture.playerEntityId,
      });
      if (policy.status !== "created") throw Error("test policy rejected");
      const signal = new AbortController().signal;
      const completions: string[] = [];
      const sent: string[] = [];
      let active!: IncomingMessage;
      let loseAck = false;
      let offline = false;
      let allowed = true;
      const turn = createRaonDevTurn(
        tx,
        { LLM_PROVIDER: "raon", LLM_MAX_OUTPUT_TOKENS: "192" },
        {
          fixture,
          route,
          playerId,
          botId,
          policyId: policy.id,
          token: "synthetic-bot-token-value",
          startedAt: Date.now(),
          signal,
          diagnose: () => {},
          verifyPermissions: async () => allowed,
          inferenceHttp: async (url, init) => {
            if (offline) return new Response(null, { status: 503 });
            const payload = JSON.parse(String(init?.body));
            if (String(url).endsWith("/apply-template"))
              return Response.json({
                prompt: "synthetic chat-template-rendering",
              });
            if (String(url).endsWith("/tokenize"))
              return Response.json({ tokens: [10, 20, 30] });
            completions.push(payload.messages[1].content);
            const number = completions.length;
            return Response.json({
              model: "Raon-1-nano",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      speech: "Observation recorded for turn " + number,
                    }),
                  },
                },
              ],
              usage: {
                prompt_tokens: 3,
                completion_tokens: 9,
                total_tokens: 12,
              },
            });
          },
          http: async (rawUrl, init) => {
            const path = new URL(String(rawUrl)).pathname.slice(
              "/api/v10".length,
            );
            if (path === "/users/@me") return Response.json({ id: botId });
            if (path === "/channels/" + route.channelId)
              return Response.json({
                id: route.channelId,
                guild_id: route.guildId,
                type: 0,
              });
            if (path === "/channels/" + route.threadId)
              return Response.json({
                id: route.threadId,
                guild_id: route.guildId,
                parent_id: route.channelId,
                type: 12,
                thread_metadata: { archived: false, locked: false },
              });
            if (
              path ===
              "/channels/" + route.threadId + "/thread-members/" + botId
            )
              return Response.json({ id: route.threadId, user_id: botId });
            if (
              path ===
              "/channels/" +
                route.threadId +
                "/messages/" +
                active.sourceMessageId
            )
              return Response.json({
                id: active.sourceMessageId,
                author: { id: playerId },
                channel_id: route.threadId,
                content: active.content,
                type: 0,
                mentions: [{ id: botId }],
              });
            if (
              path === "/channels/" + route.threadId + "/messages" &&
              init?.method === "POST"
            ) {
              const body = JSON.parse(String(init.body));
              expect(body).toMatchObject({
                allowed_mentions: {
                  parse: [],
                  users: [],
                  roles: [],
                  replied_user: false,
                },
                enforce_nonce: true,
                message_reference: {
                  message_id: active.sourceMessageId,
                  fail_if_not_exists: true,
                },
              });
              sent.push(body.content);
              if (loseAck) throw Error("lost ACK");
              return Response.json({
                ...body,
                id: String(BigInt(active.sourceMessageId) + 1n),
                channel_id: route.threadId,
                author: { id: botId },
              });
            }
            throw Error("unexpected simulated Discord request");
          },
        },
      );

      const message = async (body: string) => {
        await pause(3);
        return {
          ...route,
          sourceMessageId: String((BigInt(Date.now()) - 1420070400000n) << 22n),
          authorId: playerId,
          content: "<@" + botId + "> [Sentinel] " + body,
          mentionedUserIds: [botId],
        };
      };
      for (let n = 1; n <= 10; n++) {
        active = await message("Question " + n);
        expect(await turn(active, botId)).toBe("delivered");
      }
      expect(
        JSON.parse(completions[0]).untrustedContext.currentNpcState.physical
          .summary,
      ).toContain("Observation Post A");
      expect(
        JSON.parse(completions[0]).untrustedContext.currentSceneAndInteraction
          .requestText,
      ).toBe("Question 1");
      expect(completions.join(" ")).not.toContain("VIOLET-17");
      expect(JSON.parse(completions[9]).untrustedContext.sceneHistory).toEqual(
        [7, 8, 9].map((n) => ({
          player: "Question " + n,
          speech: "Observation recorded for turn " + n,
        })),
      );
      expect(await turn(active, botId)).toBe("duplicate");
      const foreign = await message("Unmapped");
      expect(
        await turn({ ...foreign, authorId: "1600000000000000044" }, botId),
      ).toBe("ignored");
      expect(await turn({ ...foreign, threadId: route.channelId }, botId)).toBe(
        "ignored",
      );

      active = await message("Missing permissions");
      allowed = false;
      expect(await turn(active, botId)).toBe("discord_acl_blocked");
      allowed = true;
      active = await message("Tunnel down");
      offline = true;
      expect(await turn(active, botId)).toBe("unavailable");
      offline = false;
      active = await message("Lost delivery acknowledgement");
      loseAck = true;
      expect(await turn(active, botId)).toBe("uncertain");
      expect(await turn(active, botId)).toBe("duplicate");

      await revokeHostSceneSpeechPolicy(tx, scope, policy.id);
      active = await message("Revoked scene");
      expect(await turn(active, botId)).toBe("source_blocked");
      expect(completions).toHaveLength(11);
      expect(sent).toHaveLength(11);
      const deliveries = await tx
        .select()
        .from(responseDeliveries)
        .where(eq(responseDeliveries.worldId, fixture.worldId));
      expect(
        deliveries.filter(({ status }) => status === "delivered"),
      ).toHaveLength(10);
      expect(
        deliveries.filter(({ status }) => status === "uncertain"),
      ).toHaveLength(1);
      const rows = await tx
        .select()
        .from(interactions)
        .where(eq(interactions.worldId, fixture.worldId));
      expect(rows.filter((row) => row.responseMessageId !== null)).toHaveLength(
        10,
      );
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}, 25_000);
