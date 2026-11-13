import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { createDiscordPersistence } from "../adapters/discord/persistence.js";
import { reconcilePilotPlayer } from "../admin/discord-pilot-player.js";
import { reconcilePilotPolicy } from "../admin/discord-pilot-policy.js";
import {
  verifyNpcE2eInboundFacts,
  type NpcE2eInboundConfig,
} from "../admin/discord-npc-e2e-inbound.js";
import {
  provisionDevFixture,
  type DevFixtureRoute,
} from "../admin/discord-dev-fixture.js";
import {
  grantLocalPresence,
  revokeLocalPresence,
} from "../communication/local.repository.js";
import { updateNpcState } from "../domains/npc/npc.repository.js";
import { createDiscordIntake } from "../intake/discord-intake.js";
import { createDatabaseClient } from "./client.js";
import { interactionContexts } from "./schema/interaction-contexts.js";
import { interactions } from "./schema/interactions.js";
import { responseDeliveries } from "./schema/response-deliveries.js";
import { eq } from "drizzle-orm";
import { discordIdentities } from "./schema/discord-identities.js";
import { inspectPostInboundPreviewFacts } from "../admin/discord-npc-e2e-response-preview.js";
import {
  issueHostSceneSpeechPolicy,
  readTrustedHostScenePolicy,
  revokeHostSceneSpeechPolicy,
} from "../communication/scene-speech-policies.repository.js";
import { assessOfflineSpeechReadiness } from "../communication/scene-speech-readiness.js";
import { sceneSpeechPolicies } from "./schema/scene-speech-policies.js";

const database = createDatabaseClient();
afterAll(async () => database.close());

class RollbackTest extends Error {
  constructor() {
    super("synthetic NPC Gateway test rolled back");
  }
}

function newRoute(): DevFixtureRoute {
  const base =
    1_500_000_000_000_000_000n +
    BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 12));
  return {
    guildId: String(base),
    channelId: String(base + 1n),
    threadId: String(base + 2n),
  };
}

describe("M2.14C one-shot NPC Gateway DB facts on disposable PostgreSQL 17", () => {
  it("rejects unactivated state, accepts exactly one correct owner event, audits no outbound and refuses reuse", async () => {
    await expect(
      database.db.transaction(async (tx) => {
        const key = "npc-gateway-ci-" + randomUUID();
        const route = newRoute();
        const created = await provisionDevFixture(tx, route, true, key);
        expect(created.status).toBe("created");
        const worldId = created.worldId!;
        const contextId = created.contextId!;
        const npcId = created.npcId!;
        const botId = "1566909036899868712";
        const humanId = "1888888888888888888";
        const [scene] = await tx
          .select()
          .from(interactionContexts)
          .where(eq(interactionContexts.id, contextId));
        expect(scene?.linkedLocationEntityId).toBeTruthy();
        const config: NpcE2eInboundConfig = {
          botId,
          token: "offline-fake-token-never-used",
          guildId: route.guildId,
          parentId: route.channelId,
          threadId: route.threadId,
          playerId: humanId,
          presenceId: randomUUID(),
          scope: {
            worldKey: key,
            worldId,
            contextId,
            npcId,
            playerMappingId: randomUUID(),
            policyAuditId: randomUUID(),
          },
        };

        await expect(
          verifyNpcE2eInboundFacts(tx, config, "before"),
        ).rejects.toThrow("mapped-player scene");

        const player = await reconcilePilotPlayer(tx, {
          worldKey: key,
          route,
          userId: humanId,
          mode: "enroll",
        });
        expect(player.event).toBe("pilot_player_enrolled");
        if (!("mappingId" in player)) throw new Error("missing player mapping");
        config.scope.playerMappingId = player.mappingId;

        const location = await updateNpcState(tx, worldId, npcId, {
          currentLocationId: scene!.linkedLocationEntityId,
          locationCertainty: "certain",
          expectedVersion: 1,
        });
        expect(location?.version).toBe(2);
        const grant = await grantLocalPresence(tx, {
          worldId,
          npcId,
          contextId,
        });
        expect(grant.status).toBe("granted");
        if (grant.status !== "granted")
          throw new Error("presence grant failed");
        config.presenceId = grant.evidence.id;
        const policy = await reconcilePilotPolicy(tx, {
          worldKey: key,
          route,
          mode: "enable",
          confirmedContextId: contextId,
          testUserId: humanId,
        });
        expect(policy.event).toBe("pilot_policy_changed");
        if (!("auditId" in policy)) throw new Error("missing policy audit");
        config.scope.policyAuditId = policy.auditId;

        const [operatorEntity] = await tx
          .select({ id: discordIdentities.entityId })
          .from(discordIdentities)
          .where(eq(discordIdentities.worldId, worldId))
          .limit(1);
        expect(operatorEntity?.id).toBeTruthy();
        const hostRequest = {
          worldId,
          npcId,
          contextId,
          presenceId: config.presenceId,
          issuerEntityId: operatorEntity!.id,
          decision: "allow_direct_speech" as const,
          activity: "free" as const,
          perception: "aware" as const,
          otherScene: "none" as const,
          ttlMinutes: 5,
        };
        expect(
          await issueHostSceneSpeechPolicy(tx, {
            ...hostRequest,
            issuerEntityId: randomUUID(),
          }),
        ).toMatchObject({ status: "issuer_not_found" });
        expect(
          await issueHostSceneSpeechPolicy(tx, {
            ...hostRequest,
            ttlMinutes: 31,
          }),
        ).toMatchObject({ status: "invalid_request" });
        const hostPolicy = await issueHostSceneSpeechPolicy(tx, hostRequest);
        expect(hostPolicy.status).toBe("created");
        if (hostPolicy.status !== "created")
          throw Error("missing synthetic host policy");
        // The PostgreSQL trigger prevents changing an issued decision
        // directly; only a single audited revoke is permitted.
        await expect(
          tx.transaction(async (savepoint) => {
            await savepoint
              .update(sceneSpeechPolicies)
              .set({ decision: "deny" })
              .where(eq(sceneSpeechPolicies.id, hostPolicy.id));
          }),
        ).rejects.toThrow();
        expect(await issueHostSceneSpeechPolicy(tx, hostRequest)).toMatchObject(
          {
            status: "already_open",
          },
        );
        const initialPolicy = await readTrustedHostScenePolicy(tx, {
          worldId,
          npcId,
          contextId,
          presenceId: config.presenceId,
        });
        expect(initialPolicy).toMatchObject({
          issuedByRole: "host_operator",
          issuedByEntityId: operatorEntity!.id,
          decision: "allow_direct_speech",
          activity: "free",
          perception: "aware",
          otherScene: "none",
        });

        await verifyNpcE2eInboundFacts(tx, config, "before");
        expect(await inspectPostInboundPreviewFacts(tx, config)).toMatchObject({
          status: "integrity_blocked",
          canGenerate: false,
          canSend: false,
        });
        await expect(
          verifyNpcE2eInboundFacts(
            tx,
            { ...config, presenceId: randomUUID() },
            "before",
          ),
        ).rejects.toThrow("Trusted Sentinel local presence");

        const sourceMessageId = (
          (BigInt(Date.now() + 1000) - 1420070400000n) <<
          22n
        ).toString();
        const requestText = "<@" + botId + "> [Sentinel] Report readiness.";
        const intake = createDiscordIntake(createDiscordPersistence(tx));
        const event = {
          sourceMessageId,
          authorId: humanId,
          guildId: route.guildId,
          channelId: route.channelId,
          threadId: route.threadId,
          content: requestText,
          mentionedUserIds: [botId],
        };
        expect(await intake(event, botId)).toBe("accepted");
        await verifyNpcE2eInboundFacts(tx, config, "after", sourceMessageId);
        const beforePreview = await tx
          .select()
          .from(interactions)
          .where(eq(interactions.worldId, worldId));
        expect(await inspectPostInboundPreviewFacts(tx, config)).toMatchObject({
          status: "needs_availability_review",
          availability: "unknown",
          reason: "activity_unknown",
          contactPath: "direct_in_scene",
          speechStatus: "needs_review",
          speechReason: "activity_unknown",
          canGenerate: false,
          canSend: false,
          readOnly: true,
        });
        const afterPreview = await tx
          .select()
          .from(interactions)
          .where(eq(interactions.worldId, worldId));
        expect(afterPreview).toEqual(beforePreview);
        const currentPolicy = await readTrustedHostScenePolicy(tx, {
          worldId,
          npcId,
          contextId,
          presenceId: config.presenceId,
        });
        expect(currentPolicy).not.toBeNull();
        expect(
          assessOfflineSpeechReadiness({
            worldId,
            npcId,
            contextId,
            presenceId: config.presenceId,
            interactionId: beforePreview[0]!.id,
            npcStateVersion: currentPolicy!.npcStateVersion,
            sourceMessageId,
            nowMs: Date.now() + 1500,
            contact: {
              path: "direct_in_scene",
              status: "needs_review",
              reason: "activity_unknown",
              canGenerate: false,
              canSend: false,
              canGrantPresence: false,
            },
            approval: currentPolicy,
          }),
        ).toMatchObject({
          status: "fake_rehearsal_candidate",
          canRehearseFake: true,
          canGenerate: false,
          canSend: false,
        });
        expect(await intake(event, botId)).toBe("duplicate");
        await expect(
          verifyNpcE2eInboundFacts(tx, config, "before"),
        ).rejects.toThrow("already been used");
        await expect(
          verifyNpcE2eInboundFacts(tx, config, "after", "not-a-snowflake"),
        ).rejects.toThrow("exactly one inert");

        const stored = await tx
          .select()
          .from(interactions)
          .where(eq(interactions.worldId, worldId));
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
          contextId,
          npcId,
          requestText,
          status: "received",
          communicationMode: "unknown",
          responseText: null,
        });
        const deliveries = await tx
          .select()
          .from(responseDeliveries)
          .where(eq(responseDeliveries.worldId, worldId));
        expect(deliveries).toHaveLength(0);
        expect(
          await revokeHostSceneSpeechPolicy(tx, {
            worldId,
            npcId,
            contextId,
            presenceId: config.presenceId,
          }),
        ).toMatchObject({ status: "revoked" });
        expect(
          await readTrustedHostScenePolicy(tx, {
            worldId,
            npcId,
            contextId,
            presenceId: config.presenceId,
          }),
        ).toBeNull();
        // A revoked authoritative grant must never be treated as a summon
        // or as a valid direct-scene speech candidate.
        expect(
          await revokeLocalPresence(
            tx,
            { worldId, npcId, contextId },
            config.presenceId,
          ),
        ).toMatchObject({ status: "revoked" });
        expect(await inspectPostInboundPreviewFacts(tx, config)).toMatchObject({
          status: "integrity_blocked",
          canGenerate: false,
          canSend: false,
        });
        await tx
          .update(discordIdentities)
          .set({ status: "inactive", isPrimary: false })
          .where(eq(discordIdentities.worldId, worldId));
        expect(await inspectPostInboundPreviewFacts(tx, config)).toMatchObject({
          status: "integrity_blocked",
          canGenerate: false,
          canSend: false,
        });
        throw new RollbackTest();
      }),
    ).rejects.toThrow(RollbackTest);
  }, 30_000);
});
