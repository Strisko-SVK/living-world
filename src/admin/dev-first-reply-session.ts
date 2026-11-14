import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";

import { createDatabaseClient } from "../db/client.js";
import { worlds } from "../db/schema/worlds.js";
import { interactions } from "../db/schema/interactions.js";
import { discordMessageCreatedAt } from "../intake/discord-snowflake.js";
import { firstReplyText } from "../offline/npc-first-reply-preflight.js";
import {
  firstReplyWorldKey,
  validateFirstReplyProvisionEnvironment,
} from "./dev-first-reply-provision.js";
import {
  runFirstReplyInboundCommand,
  validateFirstReplyInboundEnvironment,
} from "./dev-first-reply-inbound.js";
import {
  authenticateLocalFirstReplyOperator,
  isLocalOperatorApproved,
} from "./dev-first-reply-operator.js";
import { runFirstReplySendCommand } from "./dev-first-reply-send.js";

// M2.15P: One local operator session to avoid a 120-second gap between
// authenticated Discord inbound and the separately authorized fixed reply.
// No auto-send: the existing sender still requires a source-bound, typed
// confirmation AFTER the event, exact REST ACL/membership/source checks,
// an immutable per-event consent and its strict no-retry boundary.
type SessionStatus = "blocked" | "acknowledged" | "uncertain";
export type FirstReplySessionResult = {
  event: "npc_first_reply_session";
  status: SessionStatus;
  attempted: boolean;
  canRetry: false;
};
const report = (
  status: SessionStatus,
  attempted = false,
): FirstReplySessionResult => ({
  event: "npc_first_reply_session",
  status,
  attempted,
  canRetry: false,
});

export function parseFirstReplySessionArguments(
  args: readonly string[],
  route: { guildId: string; channelId: string; threadId: string },
): void {
  const required = [
    "--run",
    "--confirm-world",
    firstReplyWorldKey,
    "--confirm-guild",
    route.guildId,
    "--confirm-parent",
    route.channelId,
    "--confirm-thread",
    route.threadId,
    "--confirm-database",
    "living_world_gateway_dev",
    "--one-inbound",
    "--one-reply",
    "--no-retry",
  ];
  if (
    args.length !== required.length ||
    !required.every((flag, index) => args[index] === flag)
  )
    throw Error("Exact owner-scoped single-session approval is required.");
}

export function validateFirstReplySessionEnvironment(env: NodeJS.ProcessEnv): {
  guildId: string;
  channelId: string;
  threadId: string;
} {
  const { route } = validateFirstReplyProvisionEnvironment(env, "prepare");
  validateFirstReplyInboundEnvironment(env, "connect");
  if (
    env.LW_FIRST_REPLY_SESSION_APPROVED !== "true" ||
    env.LW_FIRST_REPLY_SEND_APPROVED !== "true" ||
    env.LW_FIRST_REPLY_PRIVILEGED_CONTENT_APPROVED === "true" ||
    env.NODE_ENV === "production"
  )
    throw Error(
      "A scoped operator session and fixed-text send need approvals.",
    );
  return route;
}

// DB read-only, narrow extraction of the exact ONE SDK-persisted source.
// No source content or snowflake is printed. All authoritative checks
// and both action-time network fences still belong to the existing sender.
export async function loadFirstReplySessionSource(
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  validateFirstReplySessionEnvironment(env);
  const client = createDatabaseClient(env);
  try {
    return await client.db.transaction(async (tx) => {
      await tx.execute(sql.raw("set transaction read only"));
      await tx.execute(sql.raw("set local statement_timeout = '8s'"));
      const found = await tx
        .select({ id: worlds.id })
        .from(worlds)
        .where(eq(worlds.key, firstReplyWorldKey))
        .limit(2);
      if (found.length !== 1) return null;
      const received = await tx
        .select({
          sourceMessageId: interactions.sourceMessageId,
          status: interactions.status,
        })
        .from(interactions)
        .where(eq(interactions.worldId, found[0]!.id))
        .limit(2);
      if (received.length !== 1 || received[0]?.status !== "received")
        return null;
      const messageId = received[0]!.sourceMessageId;
      const createdAt = discordMessageCreatedAt(messageId);
      if (
        createdAt === null ||
        createdAt > Date.now() ||
        Date.now() - createdAt >= 120_000
      )
        return null;
      return messageId;
    });
  } finally {
    await client.close();
  }
}

type Inbound = typeof runFirstReplyInboundCommand;
type Send = typeof runFirstReplySendCommand;
type Operator = typeof authenticateLocalFirstReplyOperator;
type Load = typeof loadFirstReplySessionSource;
export type FirstReplySessionDependencies = {
  inbound?: Inbound;
  send?: Send;
  operator?: Operator;
  load?: Load;
  interactive?: () => boolean;
};

export async function runFirstReplySessionCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: FirstReplySessionDependencies = {},
): Promise<FirstReplySessionResult> {
  let sendStarted = false;
  try {
    const route = validateFirstReplySessionEnvironment(env);
    parseFirstReplySessionArguments(args, route);
    const interactive =
      deps.interactive?.() ??
      (process.stdin.isTTY === true && process.stdout.isTTY === true);
    if (!interactive) return report("blocked");

    // Verify OS key ownership, location and 0600 *before* the source exists;
    // proof for this dummy snowflake is discarded and never authorizes a send.
    const checkOperator = deps.operator ?? authenticateLocalFirstReplyOperator;
    const operator = await checkOperator(env, "1888888888888888999");
    if (!operator || !isLocalOperatorApproved(operator))
      return report("blocked");

    const inbound = deps.inbound ?? runFirstReplyInboundCommand;
    const before = await inbound(["--preflight"], env);
    if (before.status !== "ready") return report("blocked");
    console.info(
      JSON.stringify({
        event: "npc_first_reply_session",
        status: "preflight_pass",
        canSend: false,
      }),
    );

    const received = await inbound(
      [
        "--connect",
        "--confirm-world",
        firstReplyWorldKey,
        "--confirm-guild",
        route.guildId,
        "--confirm-parent",
        route.channelId,
        "--confirm-thread",
        route.threadId,
        "--confirm-database",
        "living_world_gateway_dev",
        "--inbound-only",
        "--one-message",
      ],
      env,
    );
    if (received.status !== "received") return report("blocked");

    const sourceId = await (deps.load ?? loadFirstReplySessionSource)(env);
    if (!sourceId || !/^[1-9][0-9]{16,19}$/u.test(sourceId))
      return report("blocked");

    sendStarted = true;
    const send = deps.send ?? runFirstReplySendCommand;
    const outcome = await send(
      [
        "--send",
        "--confirm-world",
        firstReplyWorldKey,
        "--confirm-guild",
        route.guildId,
        "--confirm-parent",
        route.channelId,
        "--confirm-thread",
        route.threadId,
        "--confirm-database",
        "living_world_gateway_dev",
        "--confirm-source",
        sourceId,
        "--confirm-reply",
        firstReplyText,
        "--one-shot",
        "--no-retry",
      ],
      env,
    );
    if (outcome.status === "acknowledged") return report("acknowledged", true);
    if (outcome.status === "uncertain") return report("uncertain", true);
    return report("blocked", outcome.attempted);
  } catch {
    // If send began, ambiguity is terminal; never retry or rearm.
    return report(sendStarted ? "uncertain" : "blocked", sendStarted);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runFirstReplySessionCommand(process.argv.slice(2)).then(
    (outcome) => {
      console.info(JSON.stringify(outcome));
      if (outcome.status !== "acknowledged") process.exitCode = 1;
    },
    () => {
      console.error(JSON.stringify(report("uncertain", true)));
      process.exitCode = 1;
    },
  );
}
