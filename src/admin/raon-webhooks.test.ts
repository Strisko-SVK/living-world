import { expect, it, vi } from "vitest";
import { createRaonWebhookManager } from "./raon-webhooks.js";

const route = {
  guildId: "1600000000000000100",
  channelId: "1600000000000000101",
  threadId: "1600000000000000102",
};
const botId = "1600000000000000103";
const owned = {
  user: { id: botId },
  name: "Living World DEV NPCs",
  type: 1,
  guild_id: route.guildId,
  channel_id: route.channelId,
  id: "1600000000000000104",
  token: "synthetic_managed_webhook_token",
};
const other = { ...owned, user: { id: "1600000000000000105" } };

function manager(http: typeof fetch, canManage = async () => true) {
  const diagnose = vi.fn();
  const resolve = createRaonWebhookManager({
    route,
    botId,
    token: "synthetic-bot-token-value",
    signal: new AbortController().signal,
    canManage,
    http,
    diagnose,
  });
  return { diagnose, resolve };
}

it("coalesces concurrent creation and rediscovers the same parent webhook or its replacement", async () => {
  let stored = [other];
  const http = vi.fn(async (url, init) => {
    expect(String(url)).toBe(
      "https://discord.com/api/v10/channels/" + route.channelId + "/webhooks",
    );
    if (init?.method === "GET") return Response.json(stored);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: owned.name });
    stored = [other, owned];
    return Response.json(owned);
  });
  const { resolve, diagnose } = manager(http);
  const auth = async () => true;
  const [one, two] = await Promise.all([resolve(auth), resolve(auth)]);
  expect(one).toEqual(two);
  expect(one?.id).toBe(owned.id);
  expect(http).toHaveBeenCalledTimes(2);
  expect(await resolve(auth)).toEqual(one);
  expect(diagnose).toHaveBeenLastCalledWith({
    event: "raon_webhook",
    outcome: "reused",
  });
  stored = [other];
  expect(await resolve(auth)).toEqual(one);
  expect(
    http.mock.calls.filter((call) => call[1]?.method === "POST"),
  ).toHaveLength(2);
});

it("fails closed on missing permission, credentials, ambiguity and wrong parent", async () => {
  const http = vi.fn();
  const auth = async () => true;
  expect(await manager(http, async () => false).resolve(auth)).toBeNull();
  expect(await manager(http).resolve(async () => false)).toBeNull();
  expect(http).not.toHaveBeenCalled();

  for (const [entries, outcome] of [
    [[{ ...owned, token: undefined }], "credentials_unavailable"],
    [
      [owned, { ...owned, id: "1600000000000000106" }],
      "duplicate_owned_webhooks",
    ],
    [[{ ...owned, channel_id: route.threadId }], "wrong_destination"],
  ] as const) {
    const fetchList = vi.fn(async () => Response.json(entries));
    const { diagnose, resolve } = manager(fetchList);
    expect(await resolve(auth)).toBeNull();
    expect(diagnose).toHaveBeenLastCalledWith({
      event: "raon_webhook",
      outcome,
    });
    expect(fetchList).toHaveBeenCalledTimes(1);
  }
});

it("respects rate limits and rediscovers after uncertain create without issuing another POST", async () => {
  const auth = async () => true;
  const limited = vi.fn(
    async () =>
      new Response(null, { status: 429, headers: { "Retry-After": "5" } }),
  );
  const first = manager(limited);
  expect(await first.resolve(auth)).toBeNull();
  expect(await first.resolve(auth)).toBeNull();
  expect(limited).toHaveBeenCalledTimes(1);
  expect(first.diagnose).toHaveBeenLastCalledWith({
    event: "raon_webhook",
    outcome: "rate_limited",
  });

  let created = false;
  const unstable = vi.fn(async (_url, init) => {
    if (init?.method === "POST") throw new Error("Lost create response.");
    return Response.json(created ? [owned] : []);
  });
  const second = manager(unstable);
  expect(await second.resolve(auth)).toBeNull();
  expect(await second.resolve(auth)).toBeNull();
  created = true;
  expect((await second.resolve(auth))?.id).toBe(owned.id);
  expect(
    unstable.mock.calls.filter((call) => call[1]?.method === "POST"),
  ).toHaveLength(1);
});
