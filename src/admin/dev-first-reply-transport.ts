import { z } from "zod";

import { firstReplyText } from "../offline/npc-first-reply-preflight.js";
import type { OutboundHttp } from "../adapters/discord-outbound/transport.js";

const snowflake = z.string().regex(/^[1-9][0-9]{16,19}$/u);
const targetSchema = z.object({
  guildId: snowflake,
  parentId: snowflake,
  threadId: snowflake,
  sourceMessageId: snowflake,
  playerId: snowflake,
  botId: snowflake,
  attemptId: z.string().uuid(),
}).strict();
export type FirstReplySendTarget = z.infer<typeof targetSchema>;
export type FirstReplySendOutcome = "blocked" | "acknowledged" | "uncertain";
export type FirstReplySendResult = {
  event: "npc_first_reply_transport";
  status: FirstReplySendOutcome;
  attempts: 0 | 1;
  canRetry: false;
  messageId?: string;
};

const reply = (status: FirstReplySendOutcome, attempts: 0 | 1, messageId?: string): FirstReplySendResult => ({
  event: "npc_first_reply_transport",
  status,
  attempts,
  canRetry: false,
  ...(messageId ? {messageId} : {}),
});
const user = z.object({ id: snowflake });
const parent = z.object({id:snowflake,guild_id:snowflake,type:z.literal(0)});
const thread = z.object({
  id:snowflake,
  guild_id:snowflake,
  parent_id:snowflake,
  type:z.literal(11),
  thread_metadata:z.object({archived:z.literal(false),locked:z.literal(false)}),
});
const perms = z.object({ permissions:z.string().regex(/^\d+$/u) });
const source = z.object({
  id:snowflake,
  guild_id:snowflake,
  channel_id:snowflake,
  content:z.string(),
  author:user,
  mentions:z.array(user),
  type:z.literal(0),
  webhook_id:z.null().optional(),
});
const ackSchema = z.object({
  id:snowflake,
  guild_id:snowflake,
  channel_id:snowflake,
  content:z.literal(firstReplyText),
  author:user,
  nonce:z.union([z.string(),z.number()]).optional(),
  message_reference:z.object({message_id:snowflake}).optional(),
  webhook_id:z.null().optional(),
});
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const SEND_MESSAGES_IN_THREADS = 1n << 38n;
const needed = VIEW_CHANNEL | READ_MESSAGE_HISTORY | SEND_MESSAGES_IN_THREADS;

// This adapter owns ZERO retries. Actual HTTP can only be wired by a separate
// authenticated local operator command. Inject fake HTTP in offline tests.
export async function postFirstReplyOnce(
  raw: unknown,
  deps: {
    http: OutboundHttp;
    token: string;
    revalidateAtBoundary: () => Promise<boolean>;
    timeoutMs?: number;
  },
): Promise<FirstReplySendResult> {
  const parsed = targetSchema.safeParse(raw);
  if (!parsed.success || !/^\S{20,}$/u.test(deps.token))
    return reply("blocked",0);
  const t = parsed.data;
  const timeoutMs = deps.timeoutMs ?? 8000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10_000 ||
    new Set([t.guildId,t.parentId,t.threadId,t.sourceMessageId,t.playerId,t.botId]).size !== 6
  )
    return reply("blocked",0);

  const api = "https://discord.com/api/v10";
  async function get(path: string): Promise<unknown> {
    const url = api + path;
    const res = await deps.http(url,{
      method:"GET",
      redirect:"manual",
      signal:AbortSignal.timeout(timeoutMs),
      headers:{Authorization:"Bot "+deps.token},
    });
    if (res.status !== 200 || res.redirected || (res.url && res.url !== url))
      throw Error("Discord metadata unavailable");
    return res.json();
  }

  // Re-fetch the actual Discord route and computed bot permissions;
  // local DB data and stale Gateway cache cannot assert Discord ACL.
  try {
    const me = user.parse(await get("/users/@me"));
    if (me.id !== t.botId) return reply("blocked",0);
    const p = parent.parse(await get("/channels/"+t.parentId));
    const th = thread.parse(await get("/channels/"+t.threadId));
    if (
      p.guild_id !== t.guildId ||
      th.guild_id !== t.guildId ||
      th.parent_id !== t.parentId
    )
      return reply("blocked",0);

    const acl = perms.parse(await get(
      "/channels/"+t.threadId+"/permissions/member/"+t.botId,
    ));
    const bitset = BigInt(acl.permissions);
    if ((bitset & needed) !== needed)
      return reply("blocked",0);

    const message = source.parse(await get(
      "/channels/"+t.threadId+"/messages/"+t.sourceMessageId,
    ));
    const literal = message.content.replace(/^<@!(\d+)>/u,"<@$1>");
    if (
      message.id !== t.sourceMessageId ||
      message.guild_id !== t.guildId ||
      message.channel_id !== t.threadId ||
      message.author.id !== t.playerId ||
      message.webhook_id != null ||
      message.mentions.length !== 1 ||
      message.mentions[0]!.id !== t.botId ||
      literal !== "<@"+t.botId+"> [Sentinel] Report readiness."
    )
      return reply("blocked",0);

    // After the network metadata reads, recheck the database's authoritative
    // scene/source/host policy and the independently authenticated operator.
    if (!(await deps.revalidateAtBoundary()))
      return reply("blocked",0);
  } catch {
    return reply("blocked",0);
  }

  // From this line on, even a 429/500, failed POST or lost ACK is terminal.
  // The caller MUST durably claim the exact event before invoking this adapter.
  const url = api+"/channels/"+t.threadId+"/messages";
  const nonce = t.attemptId.replaceAll("-","").slice(0,24);
  const body = JSON.stringify({
    content:firstReplyText,
    nonce,
    enforce_nonce:true,
    allowed_mentions:{parse:[],users:[],roles:[],replied_user:false},
    message_reference:{
      type:0,
      message_id:t.sourceMessageId,
      channel_id:t.threadId,
      guild_id:t.guildId,
      fail_if_not_exists:true,
    },
  });
  try {
    const res = await deps.http(url, {
      method:"POST",
      redirect:"manual",
      signal:AbortSignal.timeout(timeoutMs),
      headers:{
        Authorization:"Bot "+deps.token,
        "Content-Type":"application/json",
      },
      body,
    });
    if (res.status !== 200 || res.redirected || (res.url && res.url !== url))
      return reply("uncertain",1);
    const ack = ackSchema.safeParse(await res.json());
    if (
      !ack.success ||
      ack.data.id === t.sourceMessageId ||
      ack.data.guild_id !== t.guildId ||
      ack.data.channel_id !== t.threadId ||
      ack.data.author.id !== t.botId ||
      ack.data.webhook_id != null ||
      String(ack.data.nonce) !== nonce ||
      ack.data.message_reference?.message_id !== t.sourceMessageId
    )
      return reply("uncertain",1);
    return reply("acknowledged",1,ack.data.id);
  } catch {
    return reply("uncertain",1);
  }
}
