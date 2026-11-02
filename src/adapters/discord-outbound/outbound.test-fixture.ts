import { vi } from "vitest";
import type { DeliveryPayload } from "../../delivery/contracts.js";
import { authorizeTarget, readOutboundConfiguration } from "./config.js";
import type { OutboundLimits } from "./limits.js";
export const webhookId = "123456789012345678";
export const version = "00000000-0000-4000-8000-000000000099";
// Intentionally fake; never connected to a Discord webhook.
export const offlineToken =
  "offline_test_token_not_a_real_credential_000000000";
export function outboundEnvironment(payload: DeliveryPayload, id = webhookId) {
  const d = payload.destination;
  return {
    DISCORD_OUTBOUND_ENABLED: "true",
    DISCORD_OUTBOUND_ALLOWLIST: JSON.stringify([
      {
        worldId: payload.scope.worldId,
        guildId: d.guildId,
        channelId: d.channelId,
        threadIds: [d.threadId],
        webhookId: id,
        credentialVersion: version,
      },
    ]),
    DISCORD_OUTBOUND_CREDENTIALS: JSON.stringify([
      { webhookId: id, version, token: offlineToken },
    ]),
  };
}
export function approvedFixture(payload: DeliveryPayload) {
  return authorizeTarget(
    readOutboundConfiguration(outboundEnvironment(payload)),
    {
      worldId: payload.scope.worldId,
      guildId: payload.destination.guildId,
      channelId: payload.destination.channelId,
      threadId: payload.destination.threadId,
    },
  );
}
export const jsonResponse = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
export const ackBody = (p: DeliveryPayload, id = webhookId) => ({
  id: "223456789012345678",
  webhook_id: id,
  channel_id: p.destination.threadId ?? p.destination.channelId,
  guild_id: p.destination.guildId,
  author: { id },
});
export function offlineHttp(
  p: DeliveryPayload,
  post: (url: string, init: RequestInit) => Promise<Response> = async () =>
    jsonResponse(ackBody(p)),
  id = webhookId,
) {
  return vi.fn(async (url: string, init: RequestInit): Promise<Response> =>
    init.method === "GET"
      ? jsonResponse({
          id,
          type: 1,
          guild_id: p.destination.guildId,
          channel_id: p.destination.channelId,
        })
      : post(url, init),
  );
}
export function memoryLimits(
  clock: () => number = () => Date.now(),
): OutboundLimits {
  let until = 0,
    disabled = false;
  return {
    check: vi.fn(async () => ({
      allowed: !disabled && clock() >= until,
      reason: disabled
        ? "credential_disabled"
        : clock() < until
          ? "rate_limited"
          : undefined,
      retryAfterMs: Math.max(0, until - clock()),
    })),
    defer: vi.fn(async (_id, ms) => {
      until = Math.max(until, clock() + ms);
    }),
    disable: vi.fn(async () => {
      disabled = true;
    }),
  };
}
