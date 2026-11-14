import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { createDatabaseClient } from "./client.js";
import { worlds } from "./schema/worlds.js";
import { interactionContexts } from "./schema/interaction-contexts.js";
import { localPresence } from "./schema/local-presence.js";
import { sceneSpeechPolicies } from "./schema/scene-speech-policies.js";
import { discordIdentities } from "./schema/discord-identities.js";
import { contextIntakePolicyAudit } from "./schema/context-intake-policy-audit.js";
import { interactions } from "./schema/interactions.js";
import { responseDeliveries } from "./schema/response-deliveries.js";
import {
  firstReplyWorldKey,
  prepareFirstReplyFixture,
  disableFirstReplyFixture,
} from "../admin/dev-first-reply-provision.js";

const client = createDatabaseClient();
afterAll(async () => client.close());

class RollbackTest extends Error {
  constructor() {
    super("test transaction rolled back");
  }
}
const freshRoute = () => {
  const base =
    1_700_000_000_000_000_000n +
    BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 13));
  return {
    guildId: String(base),
    channelId: String(base + 1n),
    threadId: String(base + 2n),
  };
};

describe("M2.15O fresh first reply fixture on disposable PostgreSQL", () => {
  it("creates one new mapped Sentinel world with host policy before any inbound, then safely disables", async () => {
    await expect(
      client.db.transaction(async (tx) => {
        const route = freshRoute();
        const created = await prepareFirstReplyFixture(
          tx,
          route,
          "1888888888888888888",
        );
        expect(created).toMatchObject({
          event: "npc_first_reply_provision",
          status: "prepared",
          worldKey: firstReplyWorldKey,
          readOnly: false,
          canSend: false,
        });
        const worldId = created.worldId!;
        const [world] = await tx
          .select()
          .from(worlds)
          .where(eq(worlds.id, worldId));
        expect(world?.key).toBe(firstReplyWorldKey);
        expect(world?.systemType).toBe("test");
        const [scene] = await tx
          .select()
          .from(interactionContexts)
          .where(eq(interactionContexts.worldId, worldId));
        expect(scene?.npcIntakePolicy).toBe("mapped_players");
        expect(scene?.externalGuildId).toBe(route.guildId);
        expect(scene?.externalChannelId).toBe(route.channelId);
        expect(scene?.externalThreadId).toBe(route.threadId);
        const players = await tx
          .select()
          .from(discordIdentities)
          .where(eq(discordIdentities.worldId, worldId));
        expect(players).toHaveLength(1);
        expect(players[0]?.discordUserId).toBe("1888888888888888888");
        const presence = await tx
          .select()
          .from(localPresence)
          .where(eq(localPresence.worldId, worldId));
        expect(presence).toHaveLength(1);
        expect(presence[0]?.revokedAt).toBeNull();
        const policy = await tx
          .select()
          .from(sceneSpeechPolicies)
          .where(eq(sceneSpeechPolicies.worldId, worldId));
        expect(policy).toHaveLength(1);
        expect(policy[0]?.issuedAt.getTime()).toBeLessThanOrEqual(
          Date.now(),
        );
        expect(policy[0]).toMatchObject({
          presenceId: presence[0]?.id,
          decision: "allow_direct_speech",
          activity: "free",
          perception: "aware",
          otherScene: "none",
          revokedAt: null,
        });
        const audits = await tx
          .select()
          .from(contextIntakePolicyAudit)
          .where(eq(contextIntakePolicyAudit.worldId, worldId));
        expect(audits).toHaveLength(1);
        expect(audits[0]?.targetPolicy).toBe("mapped_players");
        expect(
          await tx.select().from(interactions)
            .where(eq(interactions.worldId, worldId)),
        ).toHaveLength(0);
        expect(
          await tx.select().from(responseDeliveries)
            .where(eq(responseDeliveries.worldId, worldId)),
        ).toHaveLength(0);

        await expect(
          prepareFirstReplyFixture(tx, route, "1888888888888888888"),
        ).rejects.toThrow("already exists");

        const disabled = await disableFirstReplyFixture(tx, route);
        expect(disabled.status).toBe("disabled");
        expect((await disableFirstReplyFixture(tx, route)).status)
          .toBe("already_disabled");

        const [stoppedScene] = await tx.select()
          .from(interactionContexts)
          .where(eq(interactionContexts.worldId, worldId));
        expect(stoppedScene?.npcIntakePolicy).toBe("disabled");
        const [revoked] = await tx.select()
          .from(sceneSpeechPolicies)
          .where(eq(sceneSpeechPolicies.worldId, worldId));
        expect(revoked?.revokedAt).not.toBeNull();

        throw new RollbackTest();
      }),
    ).rejects.toThrow(RollbackTest);
  }, 30_000);

  it("rejects an existing different-world route and rolls back creation", async () => {
    await expect(
      client.db.transaction(async (tx) => {
        const route = freshRoute();
        await prepareFirstReplyFixture(tx, route, "1888888888888888888");
        const count = await tx.execute(sql`
          select count(*)::integer as total from worlds
          where key = ${firstReplyWorldKey}
        `);
        expect(count.rows[0]?.total).toBe(1);
        throw new RollbackTest();
      }),
    ).rejects.toThrow(RollbackTest);
  }, 30_000);
});
