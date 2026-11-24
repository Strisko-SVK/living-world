import { setTimeout as pause } from "node:timers/promises";
import { afterAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDatabaseClient } from "./client.js";
import {
  createNativeNpcRuntime,
  type NativeDiscordPort,
} from "../discord-npc/runtime.js";
import { createNpcRegistry, type SceneRoute } from "../discord-npc/registry.js";
import { ensureSceneSpeech } from "../discord-npc/scenes.js";
import { updateNpcState } from "../domains/npc/npc.repository.js";
import {
  issueHostSceneSpeechPolicy,
  revokeHostSceneSpeechPolicy,
} from "../communication/scene-speech-policies.repository.js";
import {
  discordContextMappings,
  discordRpChannels,
  sceneSpeechPolicies,
} from "./schema/index.js";
import type { IncomingMessage } from "../intake/discord-intake.js";

const db = createDatabaseClient();
afterAll(() => db.close());

it("walks native campaign onboarding, base lifecycle, user threads and recovery through PostgreSQL and simulated Discord/RAON", async () => {
  const rollback = new Error("dispose native test world");
  await expect(
    db.db.transaction(async (tx) => {
      const id = (suffix: number) =>
        String(1700000000000000000n + BigInt(suffix));
      const guildId = id(101);
      const botId = id(102);
      const ownerId = id(103);
      const playerId = id(104);
      const outsiderId = id(105);
      const categoryId = id(106);
      const makeRoute = (channel: number, thread?: number): SceneRoute => ({
        guildId,
        channelId: id(channel),
        threadId: thread ? id(thread) : null,
      });
      const office = makeRoute(110);
      const thread = makeRoute(110, 111);
      const privateThread = makeRoute(110, 112);
      const patrol = makeRoute(120);
      const patrolThread = makeRoute(120, 121);
      const shared = makeRoute(130);
      const away = makeRoute(140);
      const elsewhere = makeRoute(150);
      const unapproved = makeRoute(160);
      const archived = new Set<string>();
      let parentName = "quartermaster-office";
      let privateOpen = false;
      let permission = true;
      let manage = true;
      let absent = false;
      let loss = false;
      const feedback: string[] = [];
      const diagnostics: string[] = [];
      const output: {
        display: string;
        webhookId: string;
        scene: string;
        id: string;
      }[] = [];
      const input = new Map<string, IncomingMessage>();
      const posts = new Map<
        string,
        {
          id: string;
          token: string;
          type: number;
          name: string;
          guild_id: string;
          channel_id: string;
          user: { id: string };
        }
      >();
      const prompts: string[] = [];
      let sequence = 0n;

      const port: NativeDiscordPort = {
        async inspect(route, _userId, manageNeeded) {
          if (
            route.guildId !== guildId ||
            !permission ||
            (manageNeeded && !manage) ||
            (route.threadId && archived.has(route.threadId)) ||
            (route.threadId === privateThread.threadId && !privateOpen)
          )
            return null;
          return {
            categoryId:
              route.channelId === unapproved.channelId ? id(199) : categoryId,
            ownerId,
            threadOwnerId: route.threadId ? ownerId : undefined,
          };
        },
        guildOwner: async (guild, user) =>
          guild === guildId && user === ownerId,
        guildUser: async (guild, user) =>
          guild === guildId && [ownerId, playerId, outsiderId].includes(user),
        feedback: async (_message, content) => {
          feedback.push(content);
        },
      };
      const http: typeof fetch = async (raw, init) => {
        const url = new URL(String(raw));
        const path = url.pathname.slice("/api/v10".length);
        if (path === "/users/@me") return Response.json({ id: botId });
        const registryRoute = /^\/channels\/(\d+)\/webhooks$/u.exec(path);
        if (registryRoute) {
          const parent = registryRoute[1];
          const known = posts.get(parent);
          if (init?.method !== "POST")
            return Response.json(known ? [known] : []);
          expect(known).toBeUndefined();
          const webhook = {
            id: id(500 + sequenceCounter()),
            token: "synthetic_DISCORD_webhook_credential",
            type: 1,
            name: JSON.parse(String(init.body)).name,
            guild_id: guildId,
            channel_id: parent,
            user: { id: botId },
          };
          posts.set(parent, webhook);
          return Response.json(webhook);
        }
        if (path.startsWith("/webhooks/")) {
          const [, , webhookId] = path.split("/");
          const webhook = [...posts.values()].find((w) => w.id === webhookId);
          if (!webhook) return new Response(null, { status: 404 });
          if (init?.method !== "POST") return Response.json(webhook);
          const body = JSON.parse(String(init.body));
          const destination =
            url.searchParams.get("thread_id") ?? webhook.channel_id;
          const ackId = id(800 + sequenceCounter());
          output.push({
            display: body.username,
            scene: destination,
            webhookId,
            id: ackId,
          });
          if (loss) throw new Error("Synthetic acknowledgement lost.");
          return Response.json({
            id: ackId,
            guild_id: guildId,
            channel_id: destination,
            content: body.content,
            webhook_id: webhookId,
            author: { id: webhookId, username: body.username },
          });
        }
        if (path.endsWith("/typing"))
          return new Response(null, { status: 204 });
        if (path.includes("/thread-members/"))
          return Response.json({ id: privateThread.threadId, user_id: botId });
        const v = /^\/channels\/(\d+)\/messages\/(\d+)$/u.exec(path);
        if (v) {
          const data = input.get(v[2]);
          if (!data) return new Response(null, { status: 404 });
          return Response.json({
            id: data.sourceMessageId,
            content: data.content,
            channel_id: v[1],
            author: { id: data.authorId },
            mentions: data.mentionedUserIds.map((userId) => ({ id: userId })),
            type: data.replyToMessageId ? 19 : 0,
            ...(data.replyToMessageId && {
              message_reference: {
                message_id: data.replyToMessageId,
                channel_id: v[1],
              },
            }),
          });
        }
        const ch = path.match(/^\/channels\/(\d+)$/u)?.[1];
        const value = [thread, privateThread, patrolThread].find(
          (route) => route.threadId === ch,
        );
        if (ch && value)
          return Response.json({
            id: ch,
            guild_id: guildId,
            parent_id: value.channelId,
            type: ch === privateThread.threadId ? 12 : 11,
            thread_metadata: { archived: archived.has(ch), locked: false },
          });
        if (ch)
          return Response.json({
            id: ch,
            guild_id: guildId,
            type: 0,
            name: parentName,
          });
        throw new Error("Unexpected Discord HTTP.");
      };
      let nextId = 0;
      function sequenceCounter() {
        return nextId++;
      }

      const create = () =>
        createNativeNpcRuntime(tx, {
          guildId,
          botId,
          port,
          token: "synthetic-runtime-token-for-testing",
          startedAt: Date.now(),
          env: { LLM_PROVIDER: "raon", LLM_MAX_OUTPUT_TOKENS: "192" },
          signal: new AbortController().signal,
          diagnose: (event) => {
            diagnostics.push([event.event, event.outcome].join(":"));
          },
          http,
          inferenceHttp: async (url, init) => {
            if (absent) return new Response(null, { status: 503 });
            if (String(url).endsWith("/apply-template"))
              return Response.json({ prompt: "synthetic template" });
            if (String(url).endsWith("/tokenize"))
              return Response.json({ tokens: [1, 2, 3] });
            prompts.push(JSON.parse(String(init?.body)).messages[1].content);
            return Response.json({
              model: "Raon-1-nano",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      speech: "Synthetic reply to the player.",
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
        });
      let runtime = create();
      const mention = "<@" + botId + "> ";
      const message = async (
        route: SceneRoute,
        content: string,
        user = ownerId,
        reply?: string,
      ) => {
        await pause(3);
        const event: IncomingMessage = {
          ...route,
          authorId: user,
          content,
          replyToMessageId: reply,
          sourceMessageId: String(
            ((BigInt(Date.now()) - 1420070400000n) << 22n) + sequence++,
          ),
          mentionedUserIds: content.startsWith(mention) ? [botId] : [],
        };
        input.set(event.sourceMessageId, event);
        return event;
      };
      const say = async (
        route: SceneRoute,
        content: string,
        user?: string,
        reply?: string,
      ) => runtime.incoming(await message(route, content, user, reply), botId);
      expect(
        await say({ ...office, guildId: id(999) }, mention + "{register}"),
      ).toBe("ignored");
      expect(await say(office, mention + "{register-here}", outsiderId)).toBe(
        "command",
      );
      expect(feedback.at(-1)).toMatch(/server owner/u);
      expect(await say(office, mention + "{register-here}")).toBe("command");
      expect(await say(office, mention + "{register-here}")).toBe("command");
      expect(feedback.at(-1)).toMatch(/registered/u);
      expect(
        await runtime.command(office, ownerId, {
          action: "access",
          role: "player",
          targetId: playerId,
        }),
      ).toBe("Campaign access updated.");
      expect(
        await runtime.command(office, playerId, {
          action: "enable",
          alias: "Quartermaster",
        }),
      ).toMatch(/requires/u);
      expect(
        await runtime.command(unapproved, ownerId, {
          action: "enable",
          alias: "Quartermaster",
        }),
      ).toMatch(/approved roleplay area/u);
      expect(
        await runtime.command(office, ownerId, {
          action: "enable",
          alias: "missing",
        }),
      ).toMatch(/NPC not found/u);
      manage = false;
      expect(
        await runtime.command(office, ownerId, {
          action: "enable",
          alias: "Quartermaster",
        }),
      ).toMatch(/Manage Webhooks/u);
      manage = true;
      expect(await say(office, mention + "[Quartermaster] {enable}")).toBe(
        "command",
      );
      expect(feedback.at(-1)).toMatch(/Marcus Voss.*Create a thread/u);
      expect(await say(office, mention + "[Quartermaster] {enable}")).toBe(
        "command",
      );
      expect(posts.size).toBe(1);
      expect(
        await runtime.command(elsewhere, ownerId, {
          action: "enable",
          alias: "Quartermaster",
        }),
      ).toMatch(/already has a base/u);

      expect(
        await say(elsewhere, mention + "[Quartermaster] Are you here?"),
      ).toBe("ignored");
      parentName = "renamed-quartermaster-office";

      // No ThreadCreate event for this existing public thread. The first
      // unmarked message creates the scene and obtains a delivered reply.
      expect(await say(thread, "What did Harlan request?")).toBe("delivered");
      expect(output.at(-1)).toMatchObject({
        display: "Marcus Voss",
        scene: thread.threadId,
      });
      expect(prompts.at(-1)).toMatch(/Harlan/u);
      const firstReply = output.at(-1)!.id;
      const ownerToken = "OWNER-DIALOGUE-EVIDENCE";
      expect(
        await say(thread, "Tell me more about the valves. " + ownerToken),
      ).toBe("delivered");
      expect(await say(thread, "What do you have available?", playerId)).toBe(
        "delivered",
      );
      expect(prompts.at(-1)).not.toContain(ownerToken);
      expect(await say(thread, "Peer reply", playerId, id(888))).toBe(
        "other_reply",
      );
      expect(await say(thread, "Reply to Voss", ownerId, firstReply)).toBe(
        "delivered",
      );
      const ordered = [];
      for (let n = 0; n < 10; n++)
        ordered.push(await message(thread, "Conversation queue sequence " + n));
      const orderingStart = prompts.length;
      const results = await Promise.all(
        ordered.map((event) => runtime.incoming(event, botId)),
      );
      expect(
        results.filter((value) => value === "queue_full").length,
      ).toBeGreaterThan(0);
      const sentOrder = prompts
        .slice(orderingStart)
        .map(
          (prompt) =>
            JSON.parse(prompt).untrustedContext.currentSceneAndInteraction
              .requestText,
        );
      expect(sentOrder).toEqual(
        ordered
          .filter((_event, n) => results[n] === "delivered")
          .map((event) => event.content),
      );
      expect(await say(thread, "// Out of character")).toBe("out_of_character");
      expect(await say(thread, "What are the supplies?", outsiderId)).toBe(
        "ignored",
      );
      expect(await say(privateThread, "Can we talk privately?")).toBe(
        "discord_acl_blocked",
      );
      privateOpen = true;
      expect(await say(privateThread, "Can we talk privately?")).toBe(
        "delivered",
      );
      expect(prompts.at(-1)).not.toContain(ownerToken);
      expect(output.at(-1)?.webhookId).toBe(output[0].webhookId);

      expect(
        await runtime.command(office, ownerId, {
          action: "access",
          role: "dm",
          targetId: outsiderId,
        }),
      ).toBe("Campaign access updated.");
      expect(
        await say(patrol, mention + "[Sentinel] {enable}", outsiderId),
      ).toBe("command");
      await runtime.threadCreated(patrolThread, ownerId);
      await runtime.threadCreated(patrolThread, ownerId);
      expect(await say(patrolThread, "What is the alert level?")).toBe(
        "delivered",
      );
      expect(output.at(-1)).toMatchObject({
        display: "Sentinel-001",
        scene: patrolThread.threadId,
      });
      expect(output.at(-1)?.webhookId).not.toBe(output[0].webhookId);
      expect(
        await say(patrolThread, mention + "[Quartermaster] Are you here?"),
      ).toBe("npc_unavailable");

      expect(
        await runtime.command(shared, ownerId, {
          action: "scene",
          alias: "Quartermaster",
        }),
      ).toMatch(/explicit NPC mention/u);
      expect(await say(shared, "Unmarked shared discussion")).toBe("inactive");
      expect(
        await say(shared, mention + "[Quartermaster] Are you available?"),
      ).toBe("delivered");
      expect(output.at(-1)?.scene).toBe(shared.channelId);
      expect(
        await runtime.command(away, ownerId, {
          action: "scene",
          alias: "Sentinel",
        }),
      ).toMatch(/registered/u);
      expect(
        await say(away, mention + "[Quartermaster] Are you available?"),
      ).toBe("npc_unavailable");

      const registry = createNpcRegistry(tx, guildId);
      const c = (await registry.campaign(guildId))!;
      const roster = await registry.roster(c.worldId);
      expect(roster).toHaveLength(2);
      const npc = roster.find((r) => r.template === "quartermaster")!;
      const actor = (await registry.member(c.worldId, ownerId))!;
      const [bound] = await tx
        .select()
        .from(discordContextMappings)
        .where(eq(discordContextMappings.threadId, thread.threadId!));
      const scope = {
        worldId: c.worldId,
        contextId: bound.contextId,
        npcId: npc.npcId,
      };
      const [managed] = await tx
        .select()
        .from(sceneSpeechPolicies)
        .where(
          and(
            eq(sceneSpeechPolicies.contextId, scope.contextId),
            eq(sceneSpeechPolicies.npcId, scope.npcId),
          ),
        );
      const previous = await message(thread, "Disconnect test");
      await pause(3);
      runtime = create();
      expect(await runtime.incoming(previous, botId)).toBe("ignored");
      expect(
        await say(
          thread,
          "What did I say about valves and " + ownerToken + "?",
        ),
      ).toBe("delivered");
      expect(
        JSON.parse(prompts.at(-1)!).untrustedContext
          .olderAttributedDialogueExcerpts,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            player: expect.stringContaining(ownerToken),
          }),
        ]),
      );
      expect(
        await ensureSceneSpeech(
          tx,
          { ...scope, locationId: npc.home_id },
          scope.npcId,
          actor.entity_id,
        ),
      ).toMatchObject({ policyId: managed.id });
      expect(
        await revokeHostSceneSpeechPolicy(
          tx,
          { ...scope, presenceId: managed.presenceId },
          managed.id,
        ),
      ).toMatchObject({ status: "revoked" });
      const shortPolicy = await issueHostSceneSpeechPolicy(tx, {
        ...scope,
        presenceId: managed.presenceId,
        issuerEntityId: actor.entity_id,
        ttlMinutes: 1,
        decision: "allow_direct_speech",
        activity: "free",
        perception: "aware",
        otherScene: "none",
        discordNativeManaged: true,
      });
      expect(shortPolicy.status).toBe("created");
      const renewed = await ensureSceneSpeech(
        tx,
        { ...scope, locationId: npc.home_id },
        scope.npcId,
        actor.entity_id,
      );
      expect(renewed?.policyId).not.toBe(
        shortPolicy.status === "created" && shortPolicy.id,
      );
      expect(
        await revokeHostSceneSpeechPolicy(
          tx,
          { ...scope, presenceId: managed.presenceId },
          renewed?.policyId,
        ),
      ).toMatchObject({ status: "revoked" });
      expect(
        await issueHostSceneSpeechPolicy(tx, {
          ...scope,
          presenceId: managed.presenceId,
          issuerEntityId: actor.entity_id,
          ttlMinutes: 30,
          decision: "hold",
          activity: "busy",
          perception: "aware",
          otherScene: "none",
        }),
      ).toMatchObject({ status: "created" });
      expect(
        await say(thread, mention + "[Quartermaster] Are you still here?"),
      ).toBe("npc_unavailable");
      expect(await say(patrolThread, "And the gate?")).toBe("delivered");

      await updateNpcState(tx, c.worldId, npc.npcId, {
        availabilityState: { status: "busy" },
      });
      expect(await say(privateThread, "Are you available?")).toBe(
        "npc_unavailable",
      );
      await updateNpcState(tx, c.worldId, npc.npcId, {
        availabilityState: { status: "available" },
      });
      posts.delete(office.channelId);
      expect(await say(privateThread, "Webhook recovery.")).toBe("delivered");
      expect(output.at(-1)?.webhookId).not.toBe(output[0].webhookId);
      absent = true;
      expect(await say(privateThread, "Inference failure.")).toBe(
        "unavailable",
      );
      absent = false;
      loss = true;
      const uncertain = await message(privateThread, "Delivery failure.");
      expect(await runtime.incoming(uncertain, botId)).toBe("uncertain");
      expect(await runtime.incoming(uncertain, botId)).toBe("old_source");
      loss = false;
      permission = false;
      expect(await say(privateThread, "Discord permission failure.")).toBe(
        "discord_acl_blocked",
      );
      permission = true;
      archived.add(privateThread.threadId!);
      expect(await say(privateThread, "Archived.")).toBe("discord_acl_blocked");
      await runtime.deleted(privateThread);
      archived.delete(privateThread.threadId!);
      expect(await say(privateThread, "Deleted.")).toBe("unmapped");
      expect(
        await runtime.command(elsewhere, ownerId, {
          action: "reassign",
          alias: "Quartermaster",
        }),
      ).toMatch(/reassigned/u);
      expect(await say(thread, "Old base.")).toBe("ignored");
      expect(
        await runtime.command(elsewhere, ownerId, {
          action: "disable",
          alias: "Quartermaster",
        }),
      ).toMatch(/disabled/u);
      await runtime.deleted(patrol);
      expect(await say(patrolThread, "Old parent.")).toBe("ignored");
      expect(
        await runtime.command(office, ownerId, {
          action: "access",
          role: "remove",
          targetId: playerId,
        }),
      ).toMatch(/updated/u);
      expect(
        await say(shared, mention + "[Quartermaster] I lost access.", playerId),
      ).toBe("ignored");
      const parents = await tx.select().from(discordRpChannels);
      expect(
        parents.find((r) => r.channelId === office.channelId),
      ).toMatchObject({ active: false });
      expect(diagnostics).toContain("native_turn:delivered");
      expect(diagnostics).toContain("native_turn:uncertain");
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}, 60_000);
