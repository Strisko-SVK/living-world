import { randomUUID } from "node:crypto";
import { prepareLocalInteraction } from "../communication/local.repository.js";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { and, eq, sql } from "drizzle-orm";

import type { OutboundHttp } from "../adapters/discord-outbound/transport.js";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { devFirstReplyConsents } from "../db/schema/dev-first-reply-consents.js";
import { interactions } from "../db/schema/interactions.js";
import { responseDeliveries } from "../db/schema/response-deliveries.js";
import { sceneSpeechPolicies } from "../db/schema/scene-speech-policies.js";
import { worlds } from "../db/schema/worlds.js";
import { fingerprint, payloadSchema } from "../delivery/contracts.js";
import { firstReplyText } from "../offline/npc-first-reply-preflight.js";
import {
  claimDevOneShotConsent,
  issueDevOneShotConsent,
  type DevOneShotClaimRequest,
  type DevOneShotIssueRequest,
} from "./dev-first-reply-consent.repository.js";
import {
  firstReplyWorldKey,
  validateFirstReplyProvisionEnvironment,
} from "./dev-first-reply-provision.js";
import {
  authenticateLocalFirstReplyOperator,
  isLocalOperatorApproved,
} from "./dev-first-reply-operator.js";
import {
  inspectDevFirstReplyFacts,
  runDevFirstReplyPreview,
} from "./npc-dev-first-reply-preview.js";
import { validateGatewaySmokeConfig } from "./discord-gateway-smoke.js";
import {
  postFirstReplyOnce,
  type FirstReplySendResult,
  type FirstReplySendTarget,
} from "./dev-first-reply-transport.js";

type Database = Omit<DatabaseClient["db"], "$client">;
const snowflake = /^[1-9][0-9]{16,19}$/u;
type Route = { guildId: string; channelId: string; threadId: string };

const result = (
  status: "blocked" | "preview" | "acknowledged" | "uncertain",
  attempted: boolean,
) => ({
  event: "npc_first_reply_send" as const,
  status,
  attempted,
  canRetry: false as const,
  canGenerate: false as const,
  fixedReply: firstReplyText,
});

export function parseFirstReplySendArguments(
  args: readonly string[],
  route: Route,
) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return { mode: "preview" as const };
  const flags = [
    "--send",
    "--confirm-world",
    firstReplyWorldKey,
    "--confirm-guild",
    route.guildId,
    "--confirm-parent",
    route.channelId,
    "--confirm-thread",
    route.threadId,
    "--confirm-source",
  ];
  const rest = ["--confirm-reply", firstReplyText, "--one-shot", "--no-retry"];
  if (
    args.length !== flags.length + 1 + rest.length ||
    !flags.every((x, i) => args[i] === x) ||
    !snowflake.test(args[flags.length] ?? "") ||
    !rest.every((x, i) => args[flags.length + 1 + i] === x)
  )
    throw Error(
      "Exact fresh source and fixed-text one-shot approval required.",
    );
  return { mode: "send" as const, sourceMessageId: args[flags.length]! };
}

type Resolved = DevOneShotIssueRequest;

// Preview uses only the single currently authenticated SDK-received source;
// no user-supplied world, NPC, operator or interaction UUID is trusted.
export async function resolveFirstReplySource(
  db: Database,
  route: Route,
  playerDiscordId: string,
  sourceMessageId: string,
): Promise<Resolved | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw("set transaction read only"));
    await tx.execute(sql.raw("set local statement_timeout='8s'"));
    const preview = await inspectDevFirstReplyFacts(tx, {
      worldKey: firstReplyWorldKey,
      guildId: route.guildId,
      channelId: route.channelId,
      threadId: route.threadId,
      playerId: playerDiscordId,
    });
    if (preview.status !== "fake_only_candidate") return null;
    const found = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.key, firstReplyWorldKey))
      .limit(2);
    if (found.length !== 1) return null;
    const records = await tx
      .select()
      .from(interactions)
      .where(eq(interactions.worldId, found[0]!.id))
      .limit(2);
    const source = records[0];
    if (
      records.length !== 1 ||
      !source ||
      source.sourceMessageId !== sourceMessageId ||
      !source.speakerEntityId ||
      !source.npcId
    )
      return null;
    const policies = await tx
      .select()
      .from(sceneSpeechPolicies)
      .where(
        and(
          eq(sceneSpeechPolicies.worldId, found[0]!.id),
          eq(sceneSpeechPolicies.npcId, source.npcId),
          eq(sceneSpeechPolicies.contextId, source.contextId),
        ),
      )
      .limit(2);
    if (
      policies.length !== 1 ||
      !policies[0] ||
      policies[0].revokedAt !== null ||
      policies[0].decision !== "allow_direct_speech"
    )
      return null;
    return {
      worldKey: firstReplyWorldKey,
      worldId: found[0]!.id,
      npcId: source.npcId,
      contextId: source.contextId,
      interactionId: source.id,
      playerEntityId: source.speakerEntityId,
      playerDiscordId,
      sourceMessageId,
      guildId: route.guildId,
      parentId: route.channelId,
      threadId: route.threadId,
      operatorEntityId: policies[0].issuerEntityId,
      ttlSeconds: 90,
    };
  });
}

type Reservation = { consentId: string; attemptId: string };

export async function reserveFirstReplyExactlyOnce(
  db: Database,
  input: Resolved,
): Promise<Reservation | null> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw("set local lock_timeout='2s'"));
      await tx.execute(sql.raw("set local statement_timeout='8s'"));
      const issued = await issueDevOneShotConsent(tx, input);
      if (process.env.NODE_ENV === "test") {
        console.info(JSON.stringify({ event: "npc_first_reply_ci_issue_status", status: issued.status }));
      }
      if (issued.status !== "issued" || !issued.consentId)
        throw Error("Consent not issued.");
      const claimInput: DevOneShotClaimRequest = {
        worldKey: input.worldKey,
        worldId: input.worldId,
        npcId: input.npcId,
        contextId: input.contextId,
        interactionId: input.interactionId,
        playerEntityId: input.playerEntityId,
        playerDiscordId: input.playerDiscordId,
        sourceMessageId: input.sourceMessageId,
        guildId: input.guildId,
        parentId: input.parentId,
        threadId: input.threadId,
        operatorEntityId: input.operatorEntityId,
        consentId: issued.consentId,
      };
      const claimed = await claimDevOneShotConsent(tx, claimInput);
      if (claimed.status !== "claimed" || !claimed.attemptId)
        throw Error("One-shot source could not be claimed.");
      const payload = payloadSchema.parse({
        scope: {
          worldId: input.worldId,
          npcId: input.npcId,
          interactionId: input.interactionId,
        },
        destination: {
          provider: "discord",
          guildId: input.guildId,
          channelId: input.parentId,
          threadId: input.threadId,
        },
        replyToMessageId: input.sourceMessageId,
        identity: { displayName: "Sentinel-001", avatarUrl: null },
        content: firstReplyText,
        allowedMentions: {
          parse: [],
          users: [],
          roles: [],
          repliedUser: false,
        },
      });
      const [delivery] = await tx
        .insert(responseDeliveries)
        .values({
          id: randomUUID(),
          worldId: input.worldId,
          npcId: input.npcId,
          contextId: input.contextId,
          interactionId: input.interactionId,
          payload,
          fingerprint: fingerprint(payload),
          status: "sending",
          attempts: 1,
          attemptId: claimed.attemptId,
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
          dispatchedAt: sql`clock_timestamp()`,
          lastCode: "first_reply_claimed",
        })
        .returning({ id: responseDeliveries.id });
      if (!delivery) throw Error("Durable first-reply audit missing.");
      return { consentId: issued.consentId, attemptId: claimed.attemptId };
    });
  } catch {
    // No partial claim/outbox writes can survive a failed outer transaction.
    return null;
  }
}

// Read-only action-time fence must match the claimed event AND the sending
// outbox. The generic default preview remains strict: it rejects all outboxes.
export async function revalidateClaimedFirstReply(
  db: Database,
  input: Resolved,
  reserved: Reservation,
): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw("set transaction read only"));
      await tx.execute(sql.raw("set local statement_timeout='8s'"));
      const preview = await inspectDevFirstReplyFacts(
        tx,
        {
          worldKey: input.worldKey,
          guildId: input.guildId,
          channelId: input.parentId,
          threadId: input.threadId,
          playerId: input.playerDiscordId,
        },
        reserved.attemptId,
      );
      if (preview.status !== "fake_only_candidate") return false;
      const records = await tx
        .select()
        .from(devFirstReplyConsents)
        .where(eq(devFirstReplyConsents.id, reserved.consentId))
        .limit(2);
      const consent = records[0];
      const now = new Date();
      return (
        records.length === 1 &&
        !!consent &&
        consent.status === "claimed" &&
        consent.attemptId === reserved.attemptId &&
        consent.claimedAt !== null &&
        consent.expiresAt > now &&
        consent.worldId === input.worldId &&
        consent.contextId === input.contextId &&
        consent.npcId === input.npcId &&
        consent.interactionId === input.interactionId &&
        consent.operatorEntityId === input.operatorEntityId &&
        consent.sourceMessageId === input.sourceMessageId &&
        consent.sourceGuildId === input.guildId &&
        consent.sourceParentId === input.parentId &&
        consent.sourceThreadId === input.threadId &&
        consent.fixedReply === firstReplyText
      );
    });
  } catch {
    return false;
  }
}

// Complete the durable outbox regardless of HTTP success, HTTP failure,
// lost ACK, or action-time revocation. A send attempt is NEVER rearmed.
export async function finalizeFirstReplyAttempt(
  db: Database,
  input: Resolved,
  reserved: Reservation,
  transport: FirstReplySendResult,
): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw("set local lock_timeout='2s'"));
      await tx.execute(sql.raw("set local statement_timeout='8s'"));
      const [delivery] = await tx
        .select()
        .from(responseDeliveries)
        .where(eq(responseDeliveries.interactionId, input.interactionId))
        .for("update");
      if (
        !delivery ||
        delivery.status !== "sending" ||
        delivery.attemptId !== reserved.attemptId ||
        delivery.attempts !== 1 ||
        delivery.worldId !== input.worldId ||
        delivery.npcId !== input.npcId ||
        delivery.contextId !== input.contextId
      )
        return false;

      if (transport.status === "acknowledged" && transport.messageId) {
        // Respect 0013's immutable local-presence binding: prepare the
        // received interaction independently before recording the ACK.
        const [presence] = await tx
          .select({ id: sceneSpeechPolicies.presenceId })
          .from(sceneSpeechPolicies)
          .where(
            and(
              eq(sceneSpeechPolicies.worldId, input.worldId),
              eq(sceneSpeechPolicies.npcId, input.npcId),
              eq(sceneSpeechPolicies.contextId, input.contextId),
            ),
          )
          .limit(1);
        if (!presence) throw Error("Local presence record is missing.");
        const prepared = await prepareLocalInteraction(tx, {
          worldId: input.worldId,
          npcId: input.npcId,
          contextId: input.contextId,
          interactionId: input.interactionId,
          evidenceId: presence.id,
        });
        if (prepared.status !== "prepared")
          throw Error("Local preparation did not pass.");
        await tx
          .update(responseDeliveries)
          .set({
            status: "delivered",
            ackMessageId: transport.messageId,
            deliveredAt: sql`clock_timestamp()`,
            lastCode: "first_reply_acknowledged",
          })
          .where(eq(responseDeliveries.id, delivery.id));
        const [updated] = await tx
          .update(interactions)
          .set({
            status: "responded",
            communicationMode: "local",
            localPresenceId:
              (
                await tx
                  .select({ id: sceneSpeechPolicies.presenceId })
                  .from(sceneSpeechPolicies)
                  .where(
                    and(
                      eq(sceneSpeechPolicies.worldId, input.worldId),
                      eq(sceneSpeechPolicies.npcId, input.npcId),
                      eq(sceneSpeechPolicies.contextId, input.contextId),
                    ),
                  )
                  .limit(1)
              )[0]?.id ?? null,
            responseText: firstReplyText,
            responseMessageId: transport.messageId,
            responseClaimId: reserved.attemptId,
            responseClaimedAt: sql`clock_timestamp()`,
            responseDispatchedAt: sql`clock_timestamp()`,
            responseGenerationOutcome: "responded",
            responsePromptVersion: "dev-first-reply-fixed-v1",
            respondedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(interactions.id, input.interactionId),
              eq(interactions.status, "received"),
              sql`${interactions.responseMessageId} is null`,
            ),
          )
          .returning({ id: interactions.id });
        if (!updated)
          throw Error("First-reply acknowledgement could not be audited.");
      } else {
        await tx
          .update(responseDeliveries)
          .set({
            status: transport.status === "uncertain" ? "uncertain" : "blocked",
            lastCode:
              transport.status === "uncertain"
                ? "first_reply_uncertain"
                : "first_reply_blocked_after_claim",
          })
          .where(eq(responseDeliveries.id, delivery.id));
      }
      return true;
    });
  } catch {
    return false;
  }
}

async function ownerConfirmsOnce(sourceId: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const expected = "SEND " + sourceId.slice(-5) + " " + firstReplyText;
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(
      "For ONE irreversible reply in the verified DEV thread, type: " +
        expected +
        "\n> ",
    );
    return answer === expected;
  } finally {
    prompt.close();
  }
}

export type FirstReplyCommandDeps = {
  connect?: typeof createDatabaseClient;
  http?: OutboundHttp;
  confirm?: (sourceMessageId: string) => Promise<boolean>;
};

export async function runFirstReplySendCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: FirstReplyCommandDeps = {},
) {
  const { route, userId } = validateFirstReplyProvisionEnvironment(
    env,
    "prepare",
  );
  if (!userId) return result("blocked", false);
  const command = parseFirstReplySendArguments(args, route);
  if (command.mode === "preview") {
    const preview = await runDevFirstReplyPreview(
      ["--preview"],
      env,
      deps.connect,
    );
    return {
      ...result("preview", false),
      readiness: preview.status,
      reason: preview.reason,
    };
  }
  const sourceId = command.sourceMessageId;
  const bot = validateGatewaySmokeConfig(env);
  if (
    env.LW_FIRST_REPLY_SEND_APPROVED !== "true" ||
    bot.guildId !== route.guildId
  )
    return result("blocked", false);
  const operator = await authenticateLocalFirstReplyOperator(env, sourceId);
  if (
    !operator ||
    !isLocalOperatorApproved(operator) ||
    operator.sourceMessageId !== sourceId
  )
    return result("blocked", false);

  let claimed = false;
  const db = (deps.connect ?? createDatabaseClient)(env);
  try {
    const source = await resolveFirstReplySource(
      db.db,
      route,
      userId,
      sourceId,
    );
    if (!source) return result("blocked", false);
    const http =
      deps.http ?? ((url: string, init: RequestInit) => fetch(url, init));
    const beforeClaimTarget: FirstReplySendTarget = {
      guildId: route.guildId,
      parentId: route.channelId,
      threadId: route.threadId,
      sourceMessageId: sourceId,
      playerId: userId,
      botId: bot.botId,
      attemptId: randomUUID(),
    };
    const precheck = await postFirstReplyOnce(beforeClaimTarget, {
      http,
      token: bot.token,
      dryRun: true,
      revalidateAtBoundary: async () =>
        !!(await resolveFirstReplySource(db.db, route, userId, sourceId)),
    });
    if (precheck.status !== "prechecked") return result("blocked", false);

    const confirmed = await (deps.confirm ?? ownerConfirmsOnce)(sourceId);
    if (!confirmed) return result("blocked", false);
    const reserved = await reserveFirstReplyExactlyOnce(db.db, source);
    if (!reserved) return result("blocked", false);
    claimed = true;

    const post = await postFirstReplyOnce(
      {
        ...beforeClaimTarget,
        attemptId: reserved.attemptId,
      },
      {
        http,
        token: bot.token,
        revalidateAtBoundary: () =>
          revalidateClaimedFirstReply(db.db, source, reserved),
      },
    );
    const audited = await finalizeFirstReplyAttempt(
      db.db,
      source,
      reserved,
      post,
    );
    if (!audited) return result("uncertain", true);
    if (post.status === "acknowledged") return result("acknowledged", true);
    // A claimed event stays terminal even when no POST was sent.
    return result(post.status === "uncertain" ? "uncertain" : "blocked", true);
  } catch {
    return result(claimed ? "uncertain" : "blocked", claimed);
  } finally {
    await db.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runFirstReplySendCommand(process.argv.slice(2)).then(
    (outcome) => {
      console.info(JSON.stringify(outcome));
      if (outcome.status === "blocked" || outcome.status === "uncertain")
        process.exitCode = 1;
    },
    () => {
      console.error(
        JSON.stringify({ event: "npc_first_reply_send_failed_safely" }),
      );
      process.exitCode = 1;
    },
  );
}
