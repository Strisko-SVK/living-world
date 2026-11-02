import { z } from "zod";
import {
  fingerprint,
  payloadSchema,
  scopeSchema,
  type DeliveryScope,
  type DeliveryTransport,
  type TransportResult,
} from "../../delivery/contracts.js";
import {
  isApprovedTarget,
  matchesTarget,
  snowflake,
  type AuthorizedTarget,
} from "./config.js";
import type { OutboundLimits } from "./limits.js";
export type OutboundHttp = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export type OutboundDiagnostic = {
  event: "discord_outbound";
  outcome:
    | "attempted"
    | "confirmed"
    | "not_sent"
    | "uncertain"
    | "blocked"
    | "rate_limited"
    | "server_error";
};
export interface TransportDependencies {
  http: OutboundHttp;
  limits: OutboundLimits;
  timeoutMs?: number;
  diagnose?: (event: OutboundDiagnostic) => void;
}
const metadata = z.object({
  id: snowflake,
  type: z.literal(1),
  guild_id: snowflake,
  channel_id: snowflake,
  token: z.string().optional(),
});
const message = z.object({
  id: snowflake,
  channel_id: snowflake,
  webhook_id: snowflake,
  guild_id: snowflake.optional(),
  author: z.object({ id: snowflake }).optional(),
});
const errorBody = z.object({ code: z.number().int(), message: z.string() });
const rateBody = z.object({
  message: z.string(),
  retry_after: z.number().positive().finite(),
  global: z.boolean(),
});
const uncertain: TransportResult = { kind: "uncertain" };
const noSend = (retryable = false, retryAfterMs = 0): TransportResult => ({
  kind: "not_sent",
  retryable,
  retryAfterMs,
});
const seconds = (s: string | null): number | null => {
  if (s === null || !/^\d+(?:\.\d+)?$/u.test(s)) return null;
  const ms = Math.ceil(Number(s) * 1000);
  return Number.isFinite(ms) && ms > 0 && ms <= 86_400_000 ? ms : null;
};
export function discordPostBody(payload: unknown) {
  const p = payloadSchema.parse(payload);
  return {
    content: p.content,
    username: p.identity.displayName,
    ...(p.identity.avatarUrl ? { avatar_url: p.identity.avatarUrl } : {}),
    allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
  };
}
// All HTTP is injected. Only the separate operator CLI supplies native fetch.
export async function verifyDiscordTransport(
  approved: AuthorizedTarget,
  scope: DeliveryScope,
  intent: "execute",
  deps: TransportDependencies,
): Promise<
  | { status: "ready"; transport: DeliveryTransport }
  | { status: "blocked"; reason: string }
> {
  if (!isApprovedTarget(approved))
    return { status: "blocked", reason: "invalid_approval" };
  const { binding, credential, target } = approved;
  const timeout = deps.timeoutMs ?? 5000;
  if (
    intent !== "execute" ||
    !scopeSchema.safeParse(scope).success ||
    scope.worldId !== target.worldId ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 10_000
  )
    return { status: "blocked", reason: "invalid_approval" };
  const emit = (outcome: OutboundDiagnostic["outcome"]) => {
    try {
      deps.diagnose?.({ event: "discord_outbound", outcome });
    } catch {
      /* diagnostics are isolated */
    }
  };
  // Never accept a URL/origin from configuration or payload.
  const endpoint = `https://discord.com/api/v10/webhooks/${binding.webhookId}/${credential.token}`;
  async function request(url: string, method: "GET" | "POST", body?: string) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await deps.http(url, {
            method,
            redirect: "manual",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body }),
          });
          if (response.redirected || (response.url && response.url !== url))
            throw Error();
          let data: unknown = null;
          if (response.body) {
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let length = 0;
            try {
              while (true) {
                const part = await reader.read();
                if (part.done) break;
                length += part.value.byteLength;
                if (length > 1_048_576) throw Error();
                chunks.push(part.value);
              }
            } finally {
              reader.releaseLock();
            }
            if (
              response.headers
                .get("content-type")
                ?.toLowerCase()
                .split(";")[0]
                .trim() === "application/json"
            ) {
              try {
                data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              } catch {
                /* malformed body remains null */
              }
            }
          }
          return { status: response.status, headers: response.headers, data };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error());
          }, timeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  async function observe(r: Awaited<ReturnType<typeof request>>) {
    if ([401, 403, 404].includes(r.status))
      await deps.limits.disable(binding.webhookId, credential.version);
    if (r.status === 429) {
      emit("rate_limited");
      const parsed = rateBody.safeParse(r.data);
      if (!parsed.success) return null;
      const candidates = [seconds(String(parsed.data.retry_after))];
      for (const header of ["retry-after", "x-ratelimit-reset-after"])
        if (r.headers.has(header))
          candidates.push(seconds(r.headers.get(header)));
      if (candidates.some((n) => n === null)) {
        await deps.limits.disable(binding.webhookId, credential.version);
        return null;
      }
      const delay = Math.max(...(candidates as number[]));
      const global =
        parsed.data.global ||
        r.headers.get("x-ratelimit-global") === "true" ||
        r.headers.get("x-ratelimit-scope") === "global";
      await deps.limits.defer(binding.webhookId, delay, global);
      return delay;
    }
    if (r.headers.get("x-ratelimit-remaining") === "0") {
      const delay = seconds(r.headers.get("x-ratelimit-reset-after"));
      if (delay === null)
        await deps.limits.disable(binding.webhookId, credential.version);
      else await deps.limits.defer(binding.webhookId, delay, false);
    }
    return null;
  }
  async function verifyBinding() {
    const gate = await deps.limits.check(binding.webhookId, credential.version);
    if (!gate.allowed) return false;
    const r = await request(endpoint, "GET");
    await observe(r);
    const parsed = metadata.safeParse(r.data);
    return (
      r.status === 200 &&
      parsed.success &&
      parsed.data.id === binding.webhookId &&
      parsed.data.guild_id === target.guildId &&
      parsed.data.channel_id === target.channelId &&
      (parsed.data.token === undefined ||
        parsed.data.token === credential.token)
    );
  }
  try {
    if (!(await verifyBinding())) {
      emit("blocked");
      return { status: "blocked", reason: "webhook_unverified" };
    }
  } catch {
    emit("blocked");
    return { status: "blocked", reason: "webhook_unverified" };
  }
  return {
    status: "ready",
    transport: {
      async send(input) {
        const p = payloadSchema.safeParse(input.payload);
        if (
          !p.success ||
          !z.string().uuid().safeParse(input.attemptId).success ||
          fingerprint(p.data) !== input.fingerprint ||
          !matchesTarget(p.data, target, scope)
        ) {
          emit("blocked");
          return noSend();
        }
        // Recheck the exact approved binding at the send boundary, after M2.10's
        // preflight has committed. This GET cannot publish a message.
        try {
          if (!(await verifyBinding())) {
            emit("blocked");
            const gate = await deps.limits.check(
              binding.webhookId,
              credential.version,
            );
            return noSend(gate.reason === "rate_limited", gate.retryAfterMs);
          }
          const gate = await deps.limits.check(
            binding.webhookId,
            credential.version,
          );
          if (!gate.allowed) {
            emit("blocked");
            return noSend(gate.reason === "rate_limited", gate.retryAfterMs);
          }
          const url = new URL(endpoint);
          url.searchParams.set("wait", "true");
          if (target.threadId !== null)
            url.searchParams.set("thread_id", target.threadId);
          emit("attempted");
          const r = await request(
            url.href,
            "POST",
            JSON.stringify(discordPostBody(p.data)),
          );
          const delay = await observe(r);
          if (r.status === 200) {
            const ack = message.safeParse(r.data);
            if (
              ack.success &&
              ack.data.id !== p.data.replyToMessageId &&
              ack.data.id !== binding.webhookId &&
              ack.data.channel_id === (target.threadId ?? target.channelId) &&
              ack.data.webhook_id === binding.webhookId &&
              (ack.data.guild_id === undefined ||
                ack.data.guild_id === target.guildId) &&
              (ack.data.author === undefined ||
                ack.data.author.id === binding.webhookId)
            ) {
              emit("confirmed");
              return {
                kind: "acknowledged",
                ack: {
                  attemptId: input.attemptId,
                  fingerprint: input.fingerprint,
                  destination: p.data.destination,
                  messageId: ack.data.id,
                },
              };
            }
          }
          if (r.status === 429 && delay !== null) {
            emit("not_sent");
            return noSend(true, delay);
          }
          if (
            [400, 401, 403, 404].includes(r.status) &&
            errorBody.safeParse(r.data).success
          ) {
            emit("not_sent");
            return noSend();
          }
          if (r.status >= 500) emit("server_error");
          emit("uncertain");
          return uncertain;
        } catch {
          emit("uncertain");
          return uncertain;
        }
      },
    },
  };
}
