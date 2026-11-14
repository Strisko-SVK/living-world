import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { ChannelType, Events, MessageType, type Message } from "discord.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createDiscordAdapter } from "../adapters/discord/client.js";
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
  prepareLocalInteraction,
  revokeLocalPresence,
} from "../communication/local.repository.js";
import { getInteraction } from "../domains/interaction/interaction.repository.js";
import { createNpcContextBuilder } from "../context/context.repository.js";
import { createNpcResponseOrchestrator } from "../response/orchestrator.js";
import type { ResponseScope } from "../response/contracts.js";
import { createResponseStore } from "../response/response.repository.js";
import { createTextGenerator } from "../llm/generation.js";
import {
  enabledConfig,
  fakeBudget,
  fakeProvider,
} from "../llm/llm.test-fixture.js";
import type { TextProvider } from "../llm/contracts.js";
import type { DeliveryTransport } from "../delivery/contracts.js";
import { createDeliveryRepository } from "../delivery/delivery.repository.js";
import { createDeliveryDispatcher } from "../delivery/dispatch.js";
import { fakeDeliveryTransport } from "../delivery/delivery.test-fixture.js";
import { createOfflineNpcWorkflow } from "../offline/npc-e2e.js";
import { updateNpcState } from "../domains/npc/npc.repository.js";
import { createDiscordIntake } from "../intake/discord-intake.js";
import { createDatabaseClient } from "./client.js";
import { interactionContexts } from "./schema/interaction-contexts.js";
import { interactions } from "./schema/interactions.js";
import { responseDeliveries } from "./schema/response-deliveries.js";
import { eq, sql } from "drizzle-orm";
import { discordIdentities } from "./schema/discord-identities.js";
import { inspectPostInboundPreviewFacts } from "../admin/discord-npc-e2e-response-preview.js";
import {
  issueHostSceneSpeechPolicy,
  readTrustedHostScenePolicy,
  revokeHostSceneSpeechPolicy,
} from "../communication/scene-speech-policies.repository.js";
import { assessOfflineSpeechReadiness } from "../communication/scene-speech-readiness.js";
import { sceneSpeechPolicies } from "./schema/scene-speech-policies.js";
import { discordContextMappings } from "./schema/discord-context-mappings.js";
import {
  readVerifiedOfflineSpeechSnapshot,
  readVerifiedOfflineSpeechPhaseSnapshot,
  type OfflineSpeechPhase,
} from "../offline/npc-pg-speech-snapshot.js";
import { createOfflineSpeechRehearsal } from "../offline/npc-speech-rehearsal.js";
import { inspectDevFirstReplyFacts } from "../admin/npc-dev-first-reply-preview.js";
import {
  issueDevOneShotConsent,
  claimDevOneShotConsent,
  revokeDevOneShotConsent,
} from "../admin/dev-first-reply-consent.repository.js";
import { devFirstReplyConsents } from "./schema/dev-first-reply-consents.js";
import {
  createOfflineFirstReplyPreflight,
  firstReplyText,
} from "../offline/npc-first-reply-preflight.js";

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
        await expect(
          tx.transaction(async (savepoint) => {
            await savepoint
              .delete(sceneSpeechPolicies)
              .where(eq(sceneSpeechPolicies.id, hostPolicy.id));
          }),
        ).rejects.toThrow();
        await expect(
          tx.transaction(async (savepoint) => {
            await savepoint.execute(
              sql.raw('truncate table "npc_scene_speech_policies"'),
            );
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

        // This is a NEW synthetic CI event after the host policy. Never
        // replay the owner's consumed Sentinel message or backdate a grant.
        await tx.execute(sql`select pg_sleep(0.05)`);
        const sourceMessageId = (
          (BigInt(Date.now()) - 1420070400000n) <<
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
        // Inject an SDK-shaped MessageCreate into the real adapter using a
        // fake EventEmitter client. The login stub never opens a Gateway.
        const fakeClient = Object.assign(new EventEmitter(), {
          user: { id: botId },
          login: vi.fn().mockResolvedValue("offline"),
          destroy: vi.fn().mockResolvedValue(undefined),
        });
        const reply = vi.fn();
        const send = vi.fn();
        const outcomes: string[] = [];
        const adapter = createDiscordAdapter(
          {
            enabled: true,
            token: "offline-fake-token",
            intents: ["Guilds", "GuildMessages", "MessageContent"],
          },
          async (message, trustedBotId) => {
            outcomes.push(await intake(message, trustedBotId));
          },
          () => {},
          fakeClient as unknown as Parameters<typeof createDiscordAdapter>[3],
        );
        const sdkEvent = {
          id: sourceMessageId,
          author: { id: humanId, bot: false },
          partial: false,
          webhookId: null,
          system: false,
          guildId: route.guildId,
          channelId: route.threadId,
          type: MessageType.Default,
          content: requestText,
          channel: {
            type: ChannelType.PublicThread,
            parentId: route.channelId,
            isThread: () => true,
            send,
          },
          mentions: { users: new Map([[botId, {}]]) },
          reply,
          fetch: vi.fn(),
        } as unknown as Message;
        await adapter.start();
        fakeClient.emit(Events.MessageCreate, sdkEvent);
        await adapter.stop();
        expect(outcomes).toEqual(["accepted"]);
        expect(fakeClient.login).toHaveBeenCalledExactlyOnceWith(
          "offline-fake-token",
        );
        expect(fakeClient.destroy).toHaveBeenCalledOnce();
        expect(reply).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        await verifyNpcE2eInboundFacts(tx, config, "after", sourceMessageId);
        const beforePreview = await tx
          .select()
          .from(interactions)
          .where(eq(interactions.worldId, worldId));
        expect(beforePreview).toHaveLength(1);
        expect(beforePreview[0]!.sourceMessageId).toBe(sourceMessageId);
        // The DB receipt clock must follow the pre-existing host policy
        // even when the synthetic test owns a long outer transaction.
        expect(beforePreview[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(
          initialPolicy!.issuedAt.getTime(),
        );
        const speechScope = {
          worldId,
          npcId,
          contextId,
          interactionId: beforePreview[0]!.id,
        };
        const devPreviewTarget = {
          worldKey: key,
          guildId: route.guildId,
          channelId: route.channelId,
          threadId: route.threadId,
          playerId: humanId,
        };
        // M2.15L: an actual PostgreSQL-backed DEV-style read-only projection
        // recognizes the original inbound, policy, route and presence.
        expect(
          await inspectDevFirstReplyFacts(tx, devPreviewTarget),
        ).toMatchObject({
          status: "fake_only_candidate",
          reason: "validated_fake_only",
          readOnly: true,
          canGenerate: false,
          canSend: false,
          wouldSend: false,
        });
        expect(
          await inspectDevFirstReplyFacts(tx, {
            ...devPreviewTarget,
            threadId: route.channelId,
          }),
        ).toMatchObject({
          status: "blocked",
          canSend: false,
        });
        // M2.15M: the real PostgreSQL 17 schema/host-only repository
        // persist one original event across consent IDs. All writes here
        // are in isolated, rollback-only CI savepoints, NEVER owner DEV.
        const consentTarget = {
          worldKey: key,
          worldId,
          npcId,
          contextId,
          interactionId: speechScope.interactionId,
          playerEntityId: beforePreview[0]!.speakerEntityId!,
          playerDiscordId: humanId,
          sourceMessageId,
          guildId: route.guildId,
          parentId: route.channelId,
          threadId: route.threadId,
          operatorEntityId: operatorEntity!.id,
        };
        expect(
          await issueDevOneShotConsent(tx, {
            ...consentTarget,
            threadId: route.channelId,
            ttlSeconds: 60,
          }),
        ).toMatchObject({
          status: "blocked",
          canSend: false,
        });
        await expect(
          tx.transaction(async (oneShot) => {
            const grant = await issueDevOneShotConsent(oneShot, {
              ...consentTarget,
              ttlSeconds: 60,
            });
            expect(grant).toMatchObject({
              status: "issued",
              canSend: false,
              canGenerate: false,
              wouldSend: false,
            });
            if (!grant.consentId) throw Error("missing CI-only grant");
            const consume = { ...consentTarget, consentId: grant.consentId };
            expect(
              await issueDevOneShotConsent(oneShot, {
                ...consentTarget,
                ttlSeconds: 60,
              }),
            ).toMatchObject({ status: "already_reserved" });
            expect(
              await claimDevOneShotConsent(oneShot, consume),
            ).toMatchObject({
              status: "claimed",
              canSend: false,
            });
            expect(
              await claimDevOneShotConsent(oneShot, consume),
            ).toMatchObject({ status: "blocked" });
            expect(
              await revokeDevOneShotConsent(oneShot, consume),
            ).toMatchObject({ status: "blocked" });
            // A NEW consent ID on the same event may never rearm a claim.
            expect(
              await issueDevOneShotConsent(oneShot, {
                ...consentTarget,
                ttlSeconds: 60,
              }),
            ).toMatchObject({ status: "already_reserved" });
            const grants = await oneShot
              .select()
              .from(devFirstReplyConsents)
              .where(eq(devFirstReplyConsents.worldId, worldId));
            expect(grants).toHaveLength(1);
            expect(grants[0]).toMatchObject({
              status: "claimed",
              sourceMessageId,
              fixedReply: firstReplyText,
            });
            expect(grants[0]!.attemptId).toBeTruthy();
            await expect(
              oneShot.transaction(async (bad) => {
                await bad.update(devFirstReplyConsents)
                  .set({ fixedReply: "Forged response" })
                  .where(eq(devFirstReplyConsents.id, grant.consentId!));
              }),
            ).rejects.toThrow();
            await expect(
              oneShot.transaction(async (bad) => {
                await bad.delete(devFirstReplyConsents)
                  .where(eq(devFirstReplyConsents.id, grant.consentId!));
              }),
            ).rejects.toThrow();
            await expect(
              oneShot.transaction(async (bad) => {
                await bad.execute(
                  sql.raw('truncate table "npc_dev_first_reply_consents"'),
                );
              }),
            ).rejects.toThrow();
            throw new RollbackTest();
          }),
        ).rejects.toThrow(RollbackTest);
        expect(
          await tx.select().from(devFirstReplyConsents)
            .where(eq(devFirstReplyConsents.worldId, worldId)),
        ).toHaveLength(0);
        await expect(
          tx.transaction(async (oneShot) => {
            const grant = await issueDevOneShotConsent(oneShot, {
              ...consentTarget, ttlSeconds: 60,
            });
            if (!grant.consentId) throw Error("missing CI-only grant");
            const scope = { ...consentTarget, consentId: grant.consentId };
            expect(await revokeDevOneShotConsent(oneShot, scope)).toMatchObject({
              status: "revoked",
            });
            expect(await claimDevOneShotConsent(oneShot, scope)).toMatchObject({
              status: "blocked",
            });
            expect(await issueDevOneShotConsent(oneShot, {
              ...consentTarget, ttlSeconds: 60,
            })).toMatchObject({ status: "already_reserved" });
            throw new RollbackTest();
          }),
        ).rejects.toThrow(RollbackTest);

        const trustedSnapshot = await readVerifiedOfflineSpeechSnapshot(
          tx,
          speechScope,
        );
        expect(trustedSnapshot).toMatchObject({
          ...speechScope,
          presenceId: config.presenceId,
          sourceMessageId,
          approval: {
            issuedByRole: "host_operator",
            decision: "allow_direct_speech",
            activity: "free",
            perception: "aware",
            otherScene: "none",
          },
        });
        // Existing fake-only M2.15D coordinator now reads the actual
        // PostgreSQL-backed policy, route, identity and presence snapshot.
        // The in-memory fake receives no source text and cannot send.
        const fakeSpeech: string[] = [];
        const rehearsal = createOfflineSpeechRehearsal({
          readTrustedSnapshot: (scope) =>
            readVerifiedOfflineSpeechSnapshot(tx, scope),
          runFake: async () => {
            fakeSpeech.push("Sentinel-001: Acknowledged. Standing by.");
            return "ack";
          },
        });
        expect(await rehearsal(speechScope)).toBe("fake_ack");
        expect(fakeSpeech).toEqual([
          "Sentinel-001: Acknowledged. Standing by.",
        ]);
        expect(
          await readVerifiedOfflineSpeechSnapshot(tx, {
            ...speechScope,
            worldId: randomUUID(),
          }),
        ).toBeNull();
        expect(
          await readVerifiedOfflineSpeechSnapshot(tx, {
            ...speechScope,
            claimedDmRole: "world_dm",
          }),
        ).toBeNull();

        await expect(
          tx.transaction(async (savepoint) => {
            await savepoint
              .update(discordContextMappings)
              .set({ updatedAt: sql`clock_timestamp() + interval '5 seconds'` })
              .where(eq(discordContextMappings.worldId, worldId));
            expect(
              await readVerifiedOfflineSpeechSnapshot(savepoint, speechScope),
            ).toBeNull();
            throw new RollbackTest();
          }),
        ).rejects.toThrow(RollbackTest);
        expect(
          await readVerifiedOfflineSpeechSnapshot(tx, speechScope),
        ).not.toBeNull();
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

        // M2.15I: full, one-shot fake generation and durable fake ACK
        // against the original, adapter-backed interaction,
        // inside a nested SAVEPOINT which rolls back before the original
        // M2.15G revocation/integrity assertions proceed.
        await expect(
          tx.transaction(async (savepoint) => {
            // M2.15I: use the SAME real intake-persisted interaction.
            // The database receipt clock now permits the M2.9 presence
            // timestamp fence even inside a long rollback-only transaction.
            const actionScope = speechScope;
            const gate = (phase: OfflineSpeechPhase) =>
              readVerifiedOfflineSpeechPhaseSnapshot(
                savepoint,
                actionScope,
                phase,
              );
            expect(await gate("received")).not.toBeNull();

            // M2.15J: one read-only dry-run against the same original,
            // adapter-persisted event and PostgreSQL-scoped host approval.
            // This advisor can NEVER authorize a real network send.
            const firstReplyPreview = createOfflineFirstReplyPreflight(
              async (candidate) => {
                const verified = await readVerifiedOfflineSpeechPhaseSnapshot(
                  savepoint,
                  candidate,
                  "received",
                );
                if (!verified) return null;
                const original = await getInteraction(
                  savepoint,
                  candidate.worldId,
                  candidate.npcId,
                  candidate.interactionId,
                );
                if (
                  !original ||
                  original.status !== "received" ||
                  original.communicationMode !== "unknown" ||
                  original.sourceProvider !== "discord" ||
                  !original.speakerEntityId ||
                  !original.sourceMessageId ||
                  !original.sourceGuildId ||
                  !original.sourceChannelId ||
                  !original.sourceThreadId ||
                  !original.sourceMappingId ||
                  original.localPresenceId !== null ||
                  original.responseText !== null ||
                  original.responseClaimId !== null
                )
                  return null;
                const previous = await savepoint
                  .select({ id: responseDeliveries.id })
                  .from(responseDeliveries)
                  .where(eq(responseDeliveries.interactionId, original.id));
                return {
                  speech: verified,
                  source: {
                    worldId: original.worldId,
                    npcId: original.npcId,
                    contextId: original.contextId,
                    interactionId: original.id,
                    speakerEntityId: original.speakerEntityId,
                    sourceProvider: original.sourceProvider,
                    sourceMessageId: original.sourceMessageId,
                    sourceGuildId: original.sourceGuildId,
                    sourceChannelId: original.sourceChannelId,
                    sourceThreadId: original.sourceThreadId,
                    sourceMappingId: original.sourceMappingId,
                    status: original.status,
                    communicationMode: original.communicationMode,
                    localPresenceId: original.localPresenceId,
                    responseText: original.responseText,
                    responseClaimId: original.responseClaimId,
                  },
                  deliveryCount: previous.length,
                };
              },
            );
            const previewTarget = {
              ...actionScope,
              playerEntityId: beforePreview[0]!.speakerEntityId!,
              sourceMessageId,
              guildId: route.guildId,
              parentId: route.channelId,
              threadId: route.threadId,
            };
            expect(await firstReplyPreview(previewTarget)).toMatchObject({
              status: "fake_only_candidate",
              fixedReply: firstReplyText,
              wouldSend: false,
              canGenerate: false,
              canSend: false,
            });
            expect(
              await firstReplyPreview({
                ...previewTarget,
                threadId: route.channelId,
              }),
            ).toMatchObject({
              status: "blocked",
              reason: "source_mismatch",
            });

            const prepared = await prepareLocalInteraction(savepoint, {
              ...actionScope,
              evidenceId: config.presenceId,
            });
            expect(prepared.status).toBe("prepared");
            expect(await gate("received")).toBeNull();
            expect(await gate("prepared")).not.toBeNull();

            const fake = fakeProvider();
            let fakeModelCalls = 0;
            const guardedGenerate = async (
              request: Parameters<TextProvider["generate"]>[0],
              signal: Parameters<TextProvider["generate"]>[1],
              check: () => ReturnType<typeof gate>,
            ) => {
              if (!(await check()))
                throw Error("host scene policy not valid at generation");
              fakeModelCalls++;
              const result = await fake.generate(request, signal);
              return {
                ...result,
                text: JSON.stringify({
                  speech: firstReplyText,
                }),
              };
            };
            const provider: TextProvider = {
              ...fake,
              generate: async (request, signal) => {
                // A route change between dispatch and model invocation must
                // deny generation. Undo it before the positive fake attempt.
                await expect(
                  savepoint.transaction(async (race) => {
                    await race
                      .update(discordContextMappings)
                      .set({
                        updatedAt: sql`clock_timestamp() + interval '5 seconds'`,
                      })
                      .where(eq(discordContextMappings.worldId, worldId));
                    await expect(
                      guardedGenerate(request, signal, () =>
                        readVerifiedOfflineSpeechPhaseSnapshot(
                          race,
                          actionScope,
                          "dispatched",
                        ),
                      ),
                    ).rejects.toThrow(
                      "host scene policy not valid at generation",
                    );
                    expect(fakeModelCalls).toBe(0);
                    throw new RollbackTest();
                  }),
                ).rejects.toThrow(RollbackTest);
                return guardedGenerate(request, signal, () =>
                  gate("dispatched"),
                );
              },
            };
            const transport = fakeDeliveryTransport(new Set([worldId]));
            const guardedSend = async (
              request: Parameters<DeliveryTransport["send"]>[0],
              check: () => ReturnType<typeof gate>,
            ) => {
              if (!(await check()))
                return {
                  kind: "not_sent" as const,
                  retryable: false,
                  retryAfterMs: 0,
                };
              return transport.send(request);
            };
            const guardedTransport: DeliveryTransport = {
              send: async (request) => {
                // Revoking host approval after outbox preflight must prevent
                // the fake network boundary. Never retry an uncertain send.
                await expect(
                  savepoint.transaction(async (race) => {
                    expect(
                      await revokeHostSceneSpeechPolicy(race, {
                        worldId,
                        npcId,
                        contextId,
                        presenceId: config.presenceId,
                      }),
                    ).toMatchObject({ status: "revoked" });
                    expect(
                      await guardedSend(request, () =>
                        readVerifiedOfflineSpeechPhaseSnapshot(
                          race,
                          actionScope,
                          "sending",
                        ),
                      ),
                    ).toMatchObject({
                      kind: "not_sent",
                      retryable: false,
                    });
                    expect(transport.sent).toHaveLength(0);
                    throw new RollbackTest();
                  }),
                ).rejects.toThrow(RollbackTest);
                // Approval still holds only because the negative probe
                // rolled back. Check again immediately before fake send.
                return guardedSend(request, () => gate("sending"));
              },
            };
            const read = (scope: ResponseScope) =>
              getInteraction(
                savepoint,
                scope.worldId,
                scope.npcId,
                scope.interactionId,
              );
            const response = createNpcResponseOrchestrator({
              read,
              build: createNpcContextBuilder(savepoint),
              store: createResponseStore(savepoint),
              generate: createTextGenerator(
                enabledConfig(),
                provider,
                fakeBudget(),
              ),
            });
            const repository = createDeliveryRepository(savepoint);
            const dispatch = createDeliveryDispatcher(
              repository,
              guardedTransport,
            );
            const run = createOfflineNpcWorkflow({
              read,
              generate: (scope) =>
                response(scope.worldId, scope.npcId, scope.interactionId),
              deliver: async (scope) => {
                if (!(await gate("responded"))) return "blocked";
                const outbox = await repository.prepare(scope);
                if (
                  outbox.status !== "prepared" &&
                  outbox.status !== "existing"
                )
                  return "blocked";
                const result = await dispatch(scope);
                switch (result.status) {
                  case "delivered":
                    return "delivered";
                  case "retryable":
                    return "retryable";
                  case "failed":
                    return "failed";
                  case "uncertain":
                    return "uncertain";
                  default:
                    return "blocked";
                }
              },
            });
            expect(
              await run({
                worldId,
                npcId,
                interactionId: actionScope.interactionId,
              }),
            ).toBe("delivered");
            expect(transport.sent).toHaveLength(1);
            expect(transport.sent[0]!.payload.scope).toMatchObject({
              worldId,
              npcId,
              interactionId: actionScope.interactionId,
            });
            expect(transport.sent[0]!.payload.destination).toMatchObject({
              provider: "discord",
              guildId: route.guildId,
              channelId: route.channelId,
              threadId: route.threadId,
            });
            expect(
              await savepoint
                .select({ status: responseDeliveries.status })
                .from(responseDeliveries)
                .where(eq(responseDeliveries.worldId, worldId)),
            ).toEqual([{ status: "delivered" }]);
            expect(
              await run({
                worldId,
                npcId,
                interactionId: actionScope.interactionId,
              }),
            ).toBe("ineligible");
            expect(transport.sent).toHaveLength(1);
            expect(
              await inspectDevFirstReplyFacts(savepoint, devPreviewTarget),
            ).toMatchObject({
              status: "blocked",
              reason: "outbox_exists",
              canSend: false,
            });
            expect(await firstReplyPreview(previewTarget)).toMatchObject({
              status: "blocked",
              reason: "unverified",
              canSend: false,
            });
            throw new RollbackTest();
          }),
        ).rejects.toThrow(RollbackTest);
        // Even successfully acknowledged fake delivery leaves no record in
        // the outer synthetic test, much less in the owner's real DEV DB.
        expect(
          await readVerifiedOfflineSpeechSnapshot(tx, speechScope),
        ).not.toBeNull();
        expect(
          await tx
            .select()
            .from(responseDeliveries)
            .where(eq(responseDeliveries.worldId, worldId)),
        ).toHaveLength(0);

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
        expect(
          await readVerifiedOfflineSpeechSnapshot(tx, speechScope),
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
