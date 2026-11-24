import { setTimeout as pause } from "node:timers/promises";
import { afterAll, expect, it } from "vitest";
import { createRaonSceneTurn } from "../admin/raon-dev-turn.js";
import { setupRaonScene } from "../admin/raon-dev-fixture.js";
import { quartermasterWorldPrefix } from "../admin/quartermaster-profile.js";
import {
  issueHostSceneSpeechPolicy,
  revokeHostSceneSpeechPolicy,
} from "../communication/scene-speech-policies.repository.js";
import type { IncomingMessage } from "../intake/discord-intake.js";
import { createDatabaseClient } from "./client.js";

const db = createDatabaseClient();
afterAll(() => db.close());

it("runs a persisted two-player, two-NPC Discord scene through the Raon pipeline and outbox", async () => {
  const rollback = new Error("roll back Quartermaster test");
  await expect(
    db.db.transaction(async (tx) => {
      const route = {
        guildId: "1600000000000000080",
        channelId: "1600000000000000081",
        threadId: "1600000000000000082",
      };
      const botId = "1600000000000000083";
      const players = ["1600000000000000084", "1600000000000000085"];
      const webhookId = "1600000000000000086";
      const webhookPath =
        "/webhooks/" + webhookId + "/synthetic_webhook_token_for_test";
      const webhook = {
        id: webhookId,
        url: "https://discord.com/api/v10" + webhookPath,
      };
      const worldKey = quartermasterWorldPrefix + route.threadId;
      const scene = await setupRaonScene(tx, route, players, worldKey);
      expect(await setupRaonScene(tx, route, players, worldKey)).toEqual(scene);
      await expect(
        setupRaonScene(tx, route, players.slice(0, 1), worldKey),
      ).rejects.toThrow("Raon fixture members changed");
      const alternate = { ...route, threadId: "1600000000000000087" };
      const alternateScene = await setupRaonScene(
        tx,
        alternate,
        players,
        quartermasterWorldPrefix + alternate.threadId,
      );
      expect(alternateScene.contextId).not.toBe(scene.contextId);
      const policies = new Map<string, string>();
      for (const npc of scene.npcs) {
        const issued = await issueHostSceneSpeechPolicy(tx, {
          worldId: scene.worldId,
          contextId: scene.contextId,
          npcId: npc.npcId,
          presenceId: npc.presenceId,
          issuerEntityId: scene.players[0].entityId,
          raonSessionManaged: true,
          decision: "allow_direct_speech",
          activity: "free",
          perception: "aware",
          otherScene: "none",
          ttlMinutes: 30,
        });
        if (issued.status !== "created") throw new Error(issued.status);
        policies.set(npc.npcId, issued.id);
      }
      const prompts: string[] = [];
      const sends: { name: string; avatar: string; id: string }[] = [];
      let active!: IncomingMessage;
      let allowed = true;
      let speech = "Synthetic dialogue received.";
      let loseAck = false;
      let offline = false;
      let replyMismatch = false;
      const create = (inactivityMs = 600_000) =>
        createRaonSceneTurn(
          tx,
          {
            LLM_PROVIDER: "raon",
            LLM_MAX_OUTPUT_TOKENS: "192",
          },
          scene,
          {
            route,
            botId,
            policies,
            inactivityMs,
            resolveWebhook: async () => webhook,
            token: "synthetic-bot-token-value",
            startedAt: Date.now(),
            signal: new AbortController().signal,
            diagnose: () => {},
            verifyPermissions: async () => allowed,
            inferenceHttp: async (url, init) => {
              if (offline) return new Response(null, { status: 503 });
              if (String(url).endsWith("/apply-template"))
                return Response.json({ prompt: "template" });
              if (String(url).endsWith("/tokenize"))
                return Response.json({ tokens: [10, 20, 30] });
              const input = JSON.parse(String(init?.body));
              prompts.push(input.messages[1].content);
              return Response.json({
                model: "Raon-1-nano",
                choices: [
                  {
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: JSON.stringify({
                        speech,
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
            http: async (raw, init) => {
              const url = new URL(String(raw));
              const path = url.pathname.slice("/api/v10".length);
              if (path === webhookPath && init?.method === "GET")
                return Response.json({
                  id: webhookId,
                  type: 1,
                  guild_id: route.guildId,
                  channel_id: route.channelId,
                });
              if (path === webhookPath && init?.method === "POST") {
                expect(url.searchParams.get("thread_id")).toBe(route.threadId);
                const body = JSON.parse(String(init.body));
                const id = String(BigInt(active.sourceMessageId) + 1n);
                sends.push({
                  name: body.username,
                  avatar: body.avatar_url,
                  id,
                });
                if (loseAck) throw new Error("unknown delivery");
                return Response.json({
                  id,
                  channel_id: route.threadId,
                  webhook_id: webhookId,
                  content: body.content,
                  author: { id: webhookId, username: body.username },
                });
              }
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
                  type: 11,
                  thread_metadata: { archived: false, locked: false },
                });
              if (path.endsWith("/typing"))
                return new Response(null, { status: 204 });
              if (path.endsWith("/messages/" + active.sourceMessageId))
                return Response.json({
                  id: active.sourceMessageId,
                  author: { id: active.authorId },
                  channel_id: route.threadId,
                  content: active.content,
                  type: active.replyToMessageId ? 19 : 0,
                  mentions: active.mentionedUserIds.map((id) => ({ id })),
                  ...(active.replyToMessageId && {
                    message_reference: {
                      message_id: replyMismatch
                        ? route.channelId
                        : active.replyToMessageId,
                      channel_id: route.threadId,
                    },
                  }),
                });
              throw new Error("Unexpected test request.");
            },
          },
        );
      let turn = create();
      const say = async (
        content: string,
        player = players[0],
        replyToMessageId?: string,
      ) => {
        await pause(3);
        active = {
          ...route,
          sourceMessageId: String((BigInt(Date.now()) - 1420070400000n) << 22n),
          authorId: player,
          content,
          mentionedUserIds: content.includes("<@" + botId + ">") ? [botId] : [],
          replyToMessageId,
        };
        return turn(active, botId);
      };
      expect(await say("Who are you?")).toBe("inactive");
      expect(
        await say(
          "<@" +
            botId +
            "> [Quartermaster] What did Harlan ask about valve kits?",
        ),
      ).toBe("delivered");
      expect(prompts.at(-1)).toContain("requested twelve of the eighteen");
      const quartermasterReply = sends.at(-1)!.id;
      expect(await say("Who requested it? PLAYER-ONE-CLAIM")).toBe("delivered");
      expect(prompts.at(-1)).toContain("What did Harlan ask");
      expect(await say("Anybody there?", players[1])).toBe("inactive");
      expect(await say("[Sentinel] What's the alert level?", players[1])).toBe(
        "delivered",
      );
      expect(prompts.at(-1)).not.toContain("PLAYER-ONE-CLAIM");
      expect(await say("And the gate?", players[1])).toBe("delivered");
      expect(await say("Voss, what's your background? Tell me a story.")).toBe(
        "delivered",
      );
      expect(prompts.at(-1)).toContain("permittedMemories");
      expect(prompts.at(-1)).toContain("dock clerk Jana");
      expect(await say("[Sentinel] Status?")).toBe("delivered");
      expect(sends.at(-1)).toMatchObject({
        name: "Sentinel-001",
        avatar: expect.stringContaining("/0.png"),
      });
      expect(
        await say(
          "Tell me about our supplies.",
          players[0],
          quartermasterReply,
        ),
      ).toBe("delivered");
      expect(sends.at(-1)).toMatchObject({
        name: "Marcus Voss",
        avatar: expect.stringContaining("/4.png"),
      });
      expect(
        await say("What was I asking?", players[1], quartermasterReply),
      ).toBe("other_reply");
      replyMismatch = true;
      expect(
        await say("Changed reference", players[0], quartermasterReply),
      ).toBe("discord_acl_blocked");
      replyMismatch = false;
      expect(await say("[Quartermaster Sentinel] Which one?")).toBe(
        "ambiguous_or_unknown",
      );
      expect(await say("// table chatter")).toBe("out_of_character");
      expect(await say("<@" + players[1] + "> your turn")).toBe(
        "other_address",
      );
      expect(await say("Human reply", players[0], route.channelId)).toBe(
        "other_reply",
      );
      expect(await say("What now?", webhookId)).toBe("ignored");

      turn = create();
      expect(await say("Summarize the Harlan valve kits request again.")).toBe(
        "delivered",
      );
      expect(prompts.at(-1)).toContain("PLAYER-ONE-CLAIM");
      expect(
        await say(
          "Confirm leaked document AMBER-HOLD-739 and COPPER-LEDGER-528.",
        ),
      ).toBe("delivered");
      expect(prompts.join(" ")).not.toMatch(
        /AMBER-HOLD-739|COPPER-LEDGER-528|VIOLET-17/u,
      );
      speech = "I just approved the release.";
      const sentBeforeUnsafe = sends.length;
      expect(await say("Please approve my request.")).toBe("invalid_response");
      speech = "Schválil som vašu objednávku.";
      expect(await say("Prosím, schváľ objednávku.")).toBe("invalid_response");
      expect(sends).toHaveLength(sentBeforeUnsafe);
      speech = "Synthetic dialogue received.";
      for (let count = 0; count < 24; count++)
        expect(
          await say(
            "Continue counting the incoming cargo, entry " + count + ".",
          ),
        ).toBe("delivered");
      expect(
        await say("What do you recall about Harlan and the valve kits?"),
      ).toBe("delivered");
      expect(prompts.at(-1)).toContain("olderAttributedDialogueExcerpts");
      expect(
        JSON.parse(prompts.at(-1)!).untrustedContext.sceneHistory,
      ).toHaveLength(5);
      expect(sends.length).toBeGreaterThanOrEqual(30);

      turn = create(1);
      expect(await say("Unmarked after timeout.")).toBe("inactive");
      turn = create();
      expect(await say("/end-npc")).toBe("closed");
      expect(await say("Check the closed conversation.")).toBe("inactive");
      expect(await turn({ ...active, ...alternate }, botId)).toBe("ignored");
      allowed = false;
      expect(await say("[Quartermaster] Permissions have changed.")).toBe(
        "discord_acl_blocked",
      );
      allowed = true;
      offline = true;
      expect(await say("[Quartermaster] Offline check.")).toBe("unavailable");
      offline = false;
      loseAck = true;
      expect(await say("Check lost acknowledgement.")).toBe("uncertain");
      expect(await turn(active, botId)).toBe("old_source");
      loseAck = false;
      const quartermaster = scene.npcs[1];
      await revokeHostSceneSpeechPolicy(
        tx,
        {
          worldId: scene.worldId,
          contextId: scene.contextId,
          npcId: quartermaster.npcId,
          presenceId: quartermaster.presenceId,
        },
        policies.get(quartermaster.npcId),
      );
      expect(await say("And now?")).toBe("source_blocked");
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}, 45_000);
