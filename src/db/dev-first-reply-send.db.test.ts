import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createDiscordPersistence } from "../adapters/discord/persistence.js";
import { createDiscordIntake } from "../intake/discord-intake.js";
import {
  prepareFirstReplyFixture,
  disableFirstReplyFixture,
} from "../admin/dev-first-reply-provision.js";
import {
  reserveFirstReplyExactlyOnce,
  finalizeFirstReplyAttempt,
} from "../admin/dev-first-reply-send.js";
import { inspectDevFirstReplyFacts } from "../admin/npc-dev-first-reply-preview.js";
import { createDatabaseClient } from "./client.js";
import { discordIdentities } from "./schema/discord-identities.js";
import { interactions } from "./schema/interactions.js";
import { responseDeliveries } from "./schema/response-deliveries.js";
import { sceneSpeechPolicies } from "./schema/scene-speech-policies.js";

const db = createDatabaseClient();
afterAll(async () => db.close());
class RollbackTest extends Error {
  constructor() {
    super("sentinel first reply transaction rolled back");
  }
}
function freshRoute() {
  const base =
    1_700_000_000_000_000_000n +
    BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 13));
  return {
    guildId: String(base),
    channelId: String(base + 1n),
    threadId: String(base + 2n),
  };
}
const botId = "1566909036899868712";
const humanId = "1888888888888888888";

describe("M2.15O one-shot consent, sending fence and durable outcome on disposable PostgreSQL", () => {
  it("consumes exactly one authentic source, permanently blocks replay and audits ACK", async () => {
    await expect(
      db.db.transaction(async (tx) => {
        const route = freshRoute();
        const prepared = await prepareFirstReplyFixture(tx, route, humanId);
        expect(prepared.status).toBe("prepared");
        const worldId = prepared.worldId!;
        const contextId = prepared.contextId!;
        const npcId = prepared.npcId!;

        // The synthetic owner event is created AFTER pre-event host policy.
        await tx.execute(sql`select pg_sleep(0.05)`);
        const sourceMessageId = (
          (BigInt(Date.now()) - 1420070400000n) <<
          22n
        ).toString();
        const intake = createDiscordIntake(createDiscordPersistence(tx));
        expect(
          await intake(
            {
              sourceMessageId,
              authorId: humanId,
              guildId: route.guildId,
              channelId: route.channelId,
              threadId: route.threadId,
              content: "<@" + botId + "> [Sentinel] Report readiness.",
              mentionedUserIds: [botId],
            },
            botId,
          ),
        ).toBe("accepted");

        const [interaction] = await tx
          .select()
          .from(interactions)
          .where(eq(interactions.worldId, worldId));
        const [identity] = await tx
          .select()
          .from(discordIdentities)
          .where(eq(discordIdentities.worldId, worldId));
        const [policy] = await tx
          .select()
          .from(sceneSpeechPolicies)
          .where(eq(sceneSpeechPolicies.worldId, worldId));
        expect(interaction).toBeTruthy();
        const input = {
          worldKey: "lw-dev-first-reply-001",
          worldId,
          npcId,
          contextId,
          interactionId: interaction!.id,
          playerEntityId: identity!.entityId,
          playerDiscordId: humanId,
          sourceMessageId,
          guildId: route.guildId,
          parentId: route.channelId,
          threadId: route.threadId,
          operatorEntityId: policy!.issuerEntityId,
          ttlSeconds: 90,
        };

        const inspection = {
          worldKey: input.worldKey,
          guildId: input.guildId,
          channelId: input.parentId,
          threadId: input.threadId,
          playerId: input.playerDiscordId,
        };
        expect(await inspectDevFirstReplyFacts(tx, inspection)).toMatchObject({
          status: "fake_only_candidate",
          canSend: false,
        });

        const claimed = await reserveFirstReplyExactlyOnce(tx, input);
        expect(claimed).not.toBeNull();
        expect(claimed?.attemptId).toMatch(/^[a-f0-9-]{36}$/u);
        expect(await reserveFirstReplyExactlyOnce(tx, input)).toBeNull();
        expect(await inspectDevFirstReplyFacts(tx, inspection)).toMatchObject({
          status: "blocked",
          reason: "outbox_exists",
          canSend: false,
        });
        expect(
          await inspectDevFirstReplyFacts(tx, inspection, claimed!.attemptId),
        ).toMatchObject({ status: "fake_only_candidate", canSend: false });

        const [sending] = await tx
          .select()
          .from(responseDeliveries)
          .where(eq(responseDeliveries.worldId, worldId));
        expect(sending).toMatchObject({
          status: "sending",
          attempts: 1,
          attemptId: claimed!.attemptId,
        });

        expect(
          await finalizeFirstReplyAttempt(tx, input, claimed!, {
            event: "npc_first_reply_transport",
            status: "acknowledged",
            attempts: 1,
            canRetry: false,
            messageId: "1888888888888888666",
          }),
        ).toBe(true);
        const [delivered] = await tx
          .select()
          .from(responseDeliveries)
          .where(eq(responseDeliveries.worldId, worldId));
        const [responded] = await tx
          .select()
          .from(interactions)
          .where(eq(interactions.worldId, worldId));
        expect(delivered).toMatchObject({
          status: "delivered",
          attempts: 1,
          ackMessageId: "1888888888888888666",
        });
        expect(responded).toMatchObject({
          status: "responded",
          responseText: "Acknowledged. Standing by.",
          responseMessageId: "1888888888888888666",
        });
        expect(
          await finalizeFirstReplyAttempt(tx, input, claimed!, {
            event: "npc_first_reply_transport",
            status: "acknowledged",
            attempts: 1,
            canRetry: false,
            messageId: "1888888888888888666",
          }),
        ).toBe(false);
        const disabled = await disableFirstReplyFixture(tx, route);
        expect(disabled.status).toBe("disabled");

        throw new RollbackTest();
      }),
    ).rejects.toThrow(RollbackTest);
  }, 30_000);
});
