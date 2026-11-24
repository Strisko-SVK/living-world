import { z } from "zod";
import { readNpcWebhook } from "./dev-first-reply-transport.js";
import type { DevFixtureRoute } from "./discord-dev-fixture.js";

const webhookName = "Living World DEV NPCs";
const snowflake = z.string().regex(/^[1-9][0-9]{16,19}$/u);
const webhookEntry = z.object({
  id: snowflake,
  type: z.number(),
  name: z.string().nullable().optional(),
  user: z.object({ id: snowflake }).optional(),
  guild_id: snowflake.optional(),
  channel_id: snowflake.nullable().optional(),
  token: z.string().optional(),
});
type Webhook = ReturnType<typeof readNpcWebhook>;
type Resolution = { webhook: Webhook | null; outcome: string };

export function createRaonWebhookManager(config: {
  route: DevFixtureRoute;
  botId: string;
  token: string;
  signal: AbortSignal;
  canManage: () => Promise<boolean>;
  diagnose: (event: { event: string; outcome: string }) => void;
  manual?: Webhook;
  http?: typeof fetch;
}) {
  const { route, botId, signal } = config;
  if (
    ![route.guildId, route.channelId, route.threadId, botId].every(
      (id) => snowflake.safeParse(id).success,
    ) ||
    !/^\S{20,}$/u.test(config.token)
  )
    throw new Error("Invalid scoped webhook configuration.");
  const endpoint =
    "https://discord.com/api/v10/channels/" + route.channelId + "/webhooks";
  let operation: Promise<Resolution> | undefined;
  let cooldownUntil = 0;
  let uncertainCreation = false;

  const blocked = (outcome: string): Resolution => ({ webhook: null, outcome });
  const metadataMatches = (entry: z.infer<typeof webhookEntry>) =>
    entry.type === 1 &&
    entry.name === webhookName &&
    entry.user?.id === botId &&
    entry.guild_id === route.guildId &&
    entry.channel_id === route.channelId;

  function credential(
    entry: z.infer<typeof webhookEntry>,
    outcome: string,
  ): Resolution {
    if (!metadataMatches(entry)) return blocked("wrong_destination");
    try {
      return {
        webhook: readNpcWebhook(
          "https://discord.com/api/v10/webhooks/" +
            entry.id +
            "/" +
            entry.token,
        ),
        outcome,
      };
    } catch {
      return blocked("credentials_unavailable");
    }
  }

  const request = async (method: "GET" | "POST") => {
    const response = await (config.http ?? fetch)(endpoint, {
      method,
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      headers: {
        Authorization: "Bot " + config.token,
        "Content-Type": "application/json",
      },
      ...(method === "POST" && { body: JSON.stringify({ name: webhookName }) }),
    });
    if (response.redirected || (response.url && response.url !== endpoint))
      throw new Error("Unexpected webhook endpoint.");
    const wait =
      response.headers.get("retry-after") ??
      response.headers.get("x-ratelimit-reset-after");
    if (
      response.status === 429 ||
      response.headers.get("x-ratelimit-remaining") === "0"
    ) {
      const seconds = wait === null ? 5 : Number(wait);
      cooldownUntil =
        Date.now() +
        (Number.isFinite(seconds) ? Math.max(1, seconds) : 5) * 1000;
    }
    return response;
  };

  async function lookup(
    authorize: () => Promise<boolean>,
  ): Promise<Resolution> {
    if (!(await config.canManage()) || !(await authorize()) || signal.aborted)
      return blocked("permission_denied");
    if (Date.now() < cooldownUntil) return blocked("rate_limited");
    const list = await request("GET");
    if (list.status === 429) return blocked("rate_limited");
    if (!list.ok) return blocked("discovery_failed");
    const entries = z.array(webhookEntry).parse(await list.json());
    const owned = entries.filter(
      (entry) => entry.name === webhookName && entry.user?.id === botId,
    );
    if (owned.length > 1) return blocked("duplicate_owned_webhooks");
    if (owned.length === 1) {
      uncertainCreation = false;
      return credential(owned[0], "reused");
    }
    if (uncertainCreation) return blocked("creation_uncertain");
    if (Date.now() < cooldownUntil) return blocked("rate_limited");
    if (!(await config.canManage()) || !(await authorize()) || signal.aborted)
      return blocked("permission_denied");
    // Never send another create POST after an ambiguous result within this
    // session. The next turn can discover a webhook Discord did create.
    uncertainCreation = true;
    const created = await request("POST");
    if (created.status === 429) {
      uncertainCreation = false;
      return blocked("rate_limited");
    }
    if (!created.ok) return blocked("creation_failed");
    const result = credential(
      webhookEntry.parse(await created.json()),
      "created",
    );
    if (result.webhook) uncertainCreation = false;
    return result;
  }

  return async (authorize: () => Promise<boolean>) => {
    if (!(await authorize()) || signal.aborted) return null;
    if (config.manual) {
      config.diagnose({ event: "raon_webhook", outcome: "manual" });
      return config.manual;
    }
    operation ??= lookup(authorize)
      .catch(() => blocked("request_failed"))
      .finally(() => {
        operation = undefined;
      });
    const { webhook, outcome } = await operation;
    config.diagnose({ event: "raon_webhook", outcome });
    return !signal.aborted && (await authorize()) ? webhook : null;
  };
}
