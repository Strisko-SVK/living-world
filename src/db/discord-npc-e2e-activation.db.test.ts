import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createDatabaseClient } from "./client.js";
import { discordIdentities } from "./schema/discord-identities.js";
import { localPresence } from "./schema/local-presence.js";
import { contextIntakePolicyAudit } from "./schema/context-intake-policy-audit.js";
import { interactionContexts } from "./schema/interaction-contexts.js";
import { npcState } from "./schema/npc-state.js";
import { interactions } from "./schema/interactions.js";
import { responseDeliveries } from "./schema/response-deliveries.js";
import {
  activateNpcE2e,
  disableNpcE2eIntake,
  type NpcE2eIds,
} from "../admin/discord-npc-e2e-activation.js";
import {
  provisionDevFixture,
  type DevFixtureRoute,
} from "../admin/discord-dev-fixture.js";
import { npcE2eWorldKey } from "../admin/discord-npc-e2e-fixture.js";

const db = createDatabaseClient();
afterAll(async () => db.close());

class RollbackTest extends Error {
  constructor() {
    super("test transaction rolled back");
  }
}

function freshRoute(): DevFixtureRoute {
  const base =
    1_700_000_000_000_000_000n +
    BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 13));
  return {
    guildId: String(base),
    channelId: String(base + 1n),
    threadId: String(base + 2n),
  };
}

describe("M2.14B atomic NPC DEV activation on disposable PostgreSQL", () => {
  it("enrolls exactly one player, places Sentinel, grants presence, audits policy, and can disable", async () => {
    await expect(
      db.db.transaction(async (tx) => {
        const route = freshRoute();
        const created = await provisionDevFixture(
          tx,
          route,
          true,
          npcE2eWorldKey,
        );
        expect(created.status).toBe("created");
        const ids: NpcE2eIds = {
          worldId: created.worldId!,
          contextId: created.contextId!,
          npcId: created.npcId!,
        };
        const humanId = "1888888888888888888";
        const activated = await activateNpcE2e(tx, {
          route,
          ids,
          userId: humanId,
        });
        expect(activated).toMatchObject({
          event: "npc_e2e_activated",
          worldKey: npcE2eWorldKey,
          ...ids,
        });

        const identities = await tx
          .select()
          .from(discordIdentities)
          .where(eq(discordIdentities.worldId, ids.worldId));
        const grants = await tx
          .select()
          .from(localPresence)
          .where(eq(localPresence.worldId, ids.worldId));
        const audit = await tx
          .select()
          .from(contextIntakePolicyAudit)
          .where(eq(contextIntakePolicyAudit.worldId, ids.worldId));
        const [scene] = await tx
          .select()
          .from(interactionContexts)
          .where(eq(interactionContexts.id, ids.contextId));
        const [state] = await tx
          .select()
          .from(npcState)
          .where(eq(npcState.npcId, ids.npcId));
        expect(identities).toHaveLength(1);
        expect(identities[0]?.discordUserId).toBe(humanId);
        expect(identities[0]?.mappingType).toBe("player_character");
        expect(grants).toHaveLength(1);
        expect(grants[0]).toMatchObject({
          npcId: ids.npcId,
          contextId: ids.contextId,
          stateVersion: 2,
          revokedAt: null,
        });
        expect(scene?.npcIntakePolicy).toBe("mapped_players");
        expect(state).toMatchObject({
          currentLocationId: scene?.linkedLocationEntityId,
          locationCertainty: "certain",
          version: 2,
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          previousPolicy: "disabled",
          targetPolicy: "mapped_players",
        });
        expect(
          await tx
            .select()
            .from(interactions)
            .where(eq(interactions.worldId, ids.worldId)),
        ).toHaveLength(0);
        expect(
          await tx
            .select()
            .from(responseDeliveries)
            .where(eq(responseDeliveries.worldId, ids.worldId)),
        ).toHaveLength(0);

        await expect(
          activateNpcE2e(tx, { route, ids, userId: humanId }),
        ).rejects.toThrow();

        const disabled = await disableNpcE2eIntake(tx, { route, ids });
        expect(disabled).toMatchObject({
          event: "npc_e2e_intake_disabled",
          alreadyDisabled: false,
        });
        expect(await disableNpcE2eIntake(tx, { route, ids })).toMatchObject({
          alreadyDisabled: true,
        });
        const [disabledScene] = await tx
          .select()
          .from(interactionContexts)
          .where(eq(interactionContexts.id, ids.contextId));
        expect(disabledScene?.npcIntakePolicy).toBe("disabled");
        expect(
          await tx
            .select()
            .from(contextIntakePolicyAudit)
            .where(eq(contextIntakePolicyAudit.worldId, ids.worldId)),
        ).toHaveLength(2);

        throw new RollbackTest();
      }),
    ).rejects.toThrow(RollbackTest);
  }, 30_000);

  it("rejects wrong confirmed IDs without any player enrollment or presence", async () => {
    await expect(
      db.db.transaction(async (tx) => {
        const route = freshRoute();
        const created = await provisionDevFixture(
          tx,
          route,
          true,
          npcE2eWorldKey,
        );
        expect(created.status).toBe("created");
        const ids: NpcE2eIds = {
          worldId: created.worldId!,
          contextId: created.contextId!,
          npcId: randomUUID(),
        };
        await expect(
          activateNpcE2e(tx, {
            route,
            ids,
            userId: "1888888888888888888",
          }),
        ).rejects.toThrow("Confirmed NPC E2E fixture IDs");
        expect(
          await tx
            .select()
            .from(discordIdentities)
            .where(eq(discordIdentities.worldId, ids.worldId)),
        ).toHaveLength(0);
        expect(
          await tx
            .select()
            .from(localPresence)
            .where(eq(localPresence.worldId, ids.worldId)),
        ).toHaveLength(0);
        const [scene] = await tx
          .select()
          .from(interactionContexts)
          .where(eq(interactionContexts.id, ids.contextId));
        expect(scene?.npcIntakePolicy).toBe("disabled");
        throw new RollbackTest();
      }),
    ).rejects.toThrow(RollbackTest);
  }, 30_000);
});
