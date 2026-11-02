import { describe, expect, it, vi } from "vitest";
import { fingerprint, type DeliveryPayload } from "../../delivery/contracts.js";
import { authorizeTarget, readOutboundConfiguration } from "./config.js";
import {
  verifyDiscordTransport,
  type OutboundDiagnostic,
} from "./transport.js";
import {
  ackBody,
  approvedFixture,
  jsonResponse,
  memoryLimits,
  offlineHttp,
  offlineToken,
  outboundEnvironment,
  version,
  webhookId,
} from "./outbound.test-fixture.js";
const payload: DeliveryPayload = {
  scope: {
    worldId: "00000000-0000-4000-8000-000000000001",
    npcId: "00000000-0000-4000-8000-000000000002",
    interactionId: "00000000-0000-4000-8000-000000000003",
  },
  destination: {
    provider: "discord",
    guildId: "323456789012345678",
    channelId: "423456789012345678",
    threadId: "523456789012345678",
  },
  replyToMessageId: "623456789012345678",
  identity: {
    displayName: "Pelo",
    avatarUrl: "https://cdn.discordapp.com/avatars/123/abc.png",
  },
  content: "@everyone @here <@123> <@&456> Report.",
  allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
};
const input = (p = payload) => ({
  payload: p,
  attemptId: "00000000-0000-4000-8000-000000000004",
  fingerprint: fingerprint(p),
});
async function transport(
  http = offlineHttp(payload),
  limits = memoryLimits(),
  p = payload,
  timeoutMs = 5000,
  diagnose?: (e: OutboundDiagnostic) => void,
) {
  const result = await verifyDiscordTransport(
    approvedFixture(p),
    p.scope,
    "execute",
    { http, limits, timeoutMs, diagnose },
  );
  if (result.status !== "ready") throw Error("Fixture verification failed");
  return result.transport;
}
describe("Discord Execute Webhook offline boundary", () => {
  it.each([true, false])(
    "serializes exact scene thread=%s with wait and no native reply or ping permissions",
    async (thread) => {
      const p = {
        ...payload,
        destination: {
          ...payload.destination,
          threadId: thread ? payload.destination.threadId : null,
        },
      };
      const http = offlineHttp(p);
      const t = await transport(http, memoryLimits(), p);
      expect(await t.send(input(p))).toMatchObject({
        kind: "acknowledged",
        ack: {
          messageId: ackBody(p).id,
          destination: p.destination,
          attemptId: input().attemptId,
          fingerprint: fingerprint(p),
        },
      });
      const [url, init] = http.mock.calls.find((c) => c[1].method === "POST")!;
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://discord.com");
      expect(parsed.pathname).toBe(
        `/api/v10/webhooks/${webhookId}/${offlineToken}`,
      );
      expect(parsed.searchParams.get("wait")).toBe("true");
      expect(parsed.searchParams.get("thread_id")).toBe(
        thread ? p.destination.threadId : null,
      );
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(init.body as string)).toEqual({
        content: p.content,
        username: "Pelo",
        avatar_url: p.identity.avatarUrl,
        allowed_mentions: {
          parse: [],
          users: [],
          roles: [],
          replied_user: false,
        },
      });
      expect(
        http.mock.calls.filter((c) => c[1].method === "POST"),
      ).toHaveLength(1);
    },
  );
  it.each([204, 500, 502, 503, 302, 301])(
    "treats HTTP %i as uncertain, without retry or redirect",
    async (status) => {
      const http = offlineHttp(payload, async () =>
        status === 204
          ? new Response(null, { status })
          : jsonResponse({ message: "proxy error" }, status),
      );
      const t = await transport(http);
      expect(await t.send(input())).toEqual({ kind: "uncertain" });
      expect(
        http.mock.calls.filter((c) => c[1].method === "POST"),
      ).toHaveLength(1);
    },
  );
  it.each([400, 401, 403, 404])(
    "recognizes authoritative HTTP %i rejection as permanent no-send",
    async (status) => {
      const limits = memoryLimits();
      const http = offlineHttp(payload, async () =>
        jsonResponse({ code: 10015, message: "Rejected" }, status),
      );
      const t = await transport(http, limits);
      expect(await t.send(input())).toEqual({
        kind: "not_sent",
        retryable: false,
        retryAfterMs: 0,
      });
      if (status !== 400) {
        expect(limits.disable).toHaveBeenCalledWith(webhookId, version);
        expect(await t.send(input())).toMatchObject({ kind: "not_sent" });
        expect(
          http.mock.calls.filter((c) => c[1].method === "POST"),
        ).toHaveLength(1);
      }
    },
  );
  it.each([
    {},
    { ...ackBody(payload), id: "opaque" },
    { ...ackBody(payload), id: payload.replyToMessageId },
    { ...ackBody(payload), webhook_id: undefined },
    { ...ackBody(payload), webhook_id: "723456789012345678" },
    { ...ackBody(payload), channel_id: payload.destination.channelId },
    { ...ackBody(payload), guild_id: "723456789012345678" },
    { ...ackBody(payload), author: { id: "723456789012345678" } },
  ])("refuses missing or mismatched ACK %#", async (body) => {
    const t = await transport(
      offlineHttp(payload, async () => jsonResponse(body)),
    );
    expect(await t.send(input())).toEqual({ kind: "uncertain" });
  });
  it("accepts ACK guild absence but validates it when available", async () => {
    const body = ackBody(payload);
    const { guild_id, ...withoutGuild } = body;
    void guild_id;
    expect(
      await (
        await transport(
          offlineHttp(payload, async () => jsonResponse(withoutGuild)),
        )
      ).send(input()),
    ).toMatchObject({ kind: "acknowledged" });
  });
  it.each(["malformed", "html", "oversized", "redirected", "wrong_origin"])(
    "refuses %s transport responses",
    async (kind) => {
      const http = offlineHttp(payload, async () => {
        if (kind === "malformed")
          return new Response("{", {
            headers: { "Content-Type": "application/json" },
          });
        if (kind === "html") return new Response("<html>proxy</html>");
        if (kind === "oversized") return new Response("x".repeat(1_048_577));
        const r = jsonResponse(ackBody(payload));
        Object.defineProperty(r, kind === "redirected" ? "redirected" : "url", {
          value: kind === "redirected" ? true : "https://evil.invalid/path",
        });
        return r;
      });
      expect(await (await transport(http)).send(input())).toEqual({
        kind: "uncertain",
      });
    },
  );
  it("does not retry network errors and never emits raw secrets/speech/IDs", async () => {
    const events: OutboundDiagnostic[] = [];
    const http = offlineHttp(payload, async () => {
      throw Error(offlineToken + payload.content + payload.destination.guildId);
    });
    const t = await transport(http, memoryLimits(), payload, 5000, (e) =>
      events.push(e),
    );
    expect(await t.send(input())).toEqual({ kind: "uncertain" });
    expect(events).toEqual([
      { event: "discord_outbound", outcome: "attempted" },
      { event: "discord_outbound", outcome: "uncertain" },
    ]);
  });
  it("bounds a never-resolving HTTP call with cancellation", async () => {
    const http = offlineHttp(payload, async () => new Promise(() => {}));
    const t = await transport(http, memoryLimits(), payload, 10);
    expect(await t.send(input())).toEqual({ kind: "uncertain" });
    expect(http.mock.calls.at(-1)![1].signal!.aborted).toBe(true);
  });
  it.each(["channel", "guild", "webhook", "type", "token"])(
    "blocks wrong metadata %s before a transport exists",
    async (mismatch) => {
      const body = {
        id: webhookId,
        type: 1,
        guild_id: payload.destination.guildId,
        channel_id: payload.destination.channelId,
        token: offlineToken,
      };
      if (mismatch === "channel") body.channel_id = "723456789012345678";
      if (mismatch === "guild") body.guild_id = "723456789012345678";
      if (mismatch === "webhook") body.id = "723456789012345678";
      if (mismatch === "type") body.type = 2;
      if (mismatch === "token") body.token = "wrong-token";
      const http = vi.fn(async () => jsonResponse(body));
      expect(
        await verifyDiscordTransport(
          approvedFixture(payload),
          payload.scope,
          "execute",
          { http, limits: memoryLimits() },
        ),
      ).toMatchObject({ status: "blocked" });
      expect(http).toHaveBeenCalledTimes(1);
    },
  );
  it("revalidates changed webhook binding immediately before POST", async () => {
    const http = offlineHttp(payload);
    const t = await transport(http);
    http.mockResolvedValueOnce(
      jsonResponse({
        id: webhookId,
        type: 1,
        guild_id: payload.destination.guildId,
        channel_id: "723456789012345678",
      }),
    );
    expect(await t.send(input())).toMatchObject({
      kind: "not_sent",
      retryable: false,
    });
    expect(http.mock.calls.filter((c) => c[1].method === "POST")).toHaveLength(
      0,
    );
  });
  it.each(["world", "channel", "thread", "identity", "fingerprint"])(
    "blocks mismatched %s before POST",
    async (change) => {
      const http = offlineHttp(payload);
      const t = await transport(http);
      const request = structuredClone(input());
      if (change === "world")
        request.payload.scope.worldId = "00000000-0000-4000-8000-000000000009";
      if (change === "channel")
        request.payload.destination.channelId = "723456789012345678";
      if (change === "thread") request.payload.destination.threadId = null;
      if (change === "identity")
        request.payload.identity.displayName = "Pelo\u2028Garak";
      if (change === "fingerprint") request.fingerprint = "a".repeat(64);
      else if (change !== "identity")
        request.fingerprint = fingerprint(request.payload);
      expect(await t.send(request)).toMatchObject({
        kind: "not_sent",
        retryable: false,
      });
      expect(http).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a structurally forged approval", async () => {
    const http = offlineHttp(payload);
    const approved = approvedFixture(payload);
    expect(
      await verifyDiscordTransport({ ...approved }, payload.scope, "execute", {
        http,
        limits: memoryLimits(),
      }),
    ).toMatchObject({ status: "blocked", reason: "invalid_approval" });
    expect(http).not.toHaveBeenCalled();
  });
  it("honors fractional, scoped and global 429 delays without internal sleeping/retrying", async () => {
    let now = 0;
    const limits = memoryLimits(() => now);
    const http = offlineHttp(payload, async () =>
      jsonResponse(
        { message: "Limited", retry_after: 1.0001, global: true },
        429,
        {
          "Retry-After": "1.25",
          "X-RateLimit-Reset-After": "1.125",
          "X-RateLimit-Bucket": "bucket-fixture",
          "X-RateLimit-Scope": "global",
        },
      ),
    );
    const t = await transport(http, limits);
    expect(await t.send(input())).toEqual({
      kind: "not_sent",
      retryable: true,
      retryAfterMs: 1250,
    });
    expect(limits.defer).toHaveBeenCalledWith(webhookId, 1250, true);
    expect(await t.send(input())).toEqual({
      kind: "not_sent",
      retryable: true,
      retryAfterMs: 1250,
    });
    expect(http.mock.calls.filter((c) => c[1].method === "POST")).toHaveLength(
      1,
    );
    now = 1250;
    expect(await t.send(input())).toMatchObject({
      kind: "not_sent",
      retryable: true,
    });
  });
  it.each(["missing", "negative", "oversized", "bad_header"])(
    "treats untrustworthy 429 %s as uncertain",
    async (kind) => {
      const body =
        kind === "missing"
          ? {}
          : {
              message: "Limited",
              retry_after:
                kind === "negative" ? -1 : kind === "oversized" ? 86401 : 1,
              global: false,
            };
      const http = offlineHttp(payload, async () =>
        jsonResponse(
          body,
          429,
          kind === "bad_header" ? { "Retry-After": "NaN" } : {},
        ),
      );
      expect(await (await transport(http)).send(input())).toEqual({
        kind: "uncertain",
      });
    },
  );
  it("honors exhausted success buckets before the next command can POST", async () => {
    let now = 0;
    const limits = memoryLimits(() => now);
    const http = offlineHttp(payload, async () =>
      jsonResponse(ackBody(payload), 200, {
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset-After": "0.2501",
        "X-RateLimit-Bucket": "bucket-fixture",
      }),
    );
    const t = await transport(http, limits);
    expect((await t.send(input())).kind).toBe("acknowledged");
    expect(limits.defer).toHaveBeenCalledWith(webhookId, 251, false);
    expect((await t.send(input())).kind).toBe("not_sent");
    now = 251;
    expect((await t.send(input())).kind).toBe("acknowledged");
  });
  it("prohibits ambient HTTP in the test process", async () => {
    await expect(
      fetch("https://discord.com/api/v10/webhooks/never/execute", {
        method: "POST",
      }),
    ).rejects.toThrow("Ambient HTTP is disabled");
  });
});
describe("strict configuration and credential rotation", () => {
  it.each([undefined, "false", "TRUE", "1"])(
    "defaults outbound OFF for %s",
    (value) =>
      expect(() =>
        readOutboundConfiguration({
          ...outboundEnvironment(payload),
          DISCORD_OUTBOUND_ENABLED: value,
        }),
      ).toThrow("blocked"),
  );
  it.each(["url", "origin", "wildcard", "token_path", "duplicate", "empty"])(
    "fails closed for %s configuration",
    (change) => {
      const env = outboundEnvironment(payload);
      const bindings = JSON.parse(env.DISCORD_OUTBOUND_ALLOWLIST);
      const creds = JSON.parse(env.DISCORD_OUTBOUND_CREDENTIALS);
      if (change === "url") bindings[0].url = "https://evil.invalid/webhook";
      if (change === "origin") bindings[0].origin = "https://evil.invalid";
      if (change === "wildcard") bindings[0].threadIds = ["*"];
      if (change === "token_path") creds[0].token = "../" + offlineToken;
      if (change === "duplicate") bindings.push(bindings[0]);
      if (change === "empty") bindings.length = 0;
      expect(() =>
        readOutboundConfiguration({
          ...env,
          DISCORD_OUTBOUND_ALLOWLIST: JSON.stringify(bindings),
          DISCORD_OUTBOUND_CREDENTIALS: JSON.stringify(creds),
        }),
      ).toThrow("blocked");
    },
  );
  it("requires exact allowlisted thread and matching credential version", () => {
    const config = readOutboundConfiguration(outboundEnvironment(payload));
    expect(() =>
      authorizeTarget(config, {
        worldId: payload.scope.worldId,
        guildId: payload.destination.guildId,
        channelId: payload.destination.channelId,
        threadId: null,
      }),
    ).toThrow("blocked");
    const env = outboundEnvironment(payload);
    const creds = JSON.parse(env.DISCORD_OUTBOUND_CREDENTIALS);
    creds[0].version = payload.scope.worldId;
    expect(() =>
      authorizeTarget(
        readOutboundConfiguration({
          ...env,
          DISCORD_OUTBOUND_CREDENTIALS: JSON.stringify(creds),
        }),
        approvedFixture(payload).target,
      ),
    ).toThrow("blocked");
  });
  it("uses rotated credentials only after fresh metadata verification", async () => {
    const env = outboundEnvironment(payload);
    const bindings = JSON.parse(env.DISCORD_OUTBOUND_ALLOWLIST),
      creds = JSON.parse(env.DISCORD_OUTBOUND_CREDENTIALS);
    bindings[0].credentialVersion = payload.scope.worldId;
    creds[0].version = payload.scope.worldId;
    creds[0].token = "rotated_offline_token_not_real_000000000000";
    const approved = authorizeTarget(
      readOutboundConfiguration({
        ...env,
        DISCORD_OUTBOUND_ALLOWLIST: JSON.stringify(bindings),
        DISCORD_OUTBOUND_CREDENTIALS: JSON.stringify(creds),
      }),
      approvedFixture(payload).target,
    );
    const http = offlineHttp(payload);
    expect(
      (
        await verifyDiscordTransport(approved, payload.scope, "execute", {
          http,
          limits: memoryLimits(),
        })
      ).status,
    ).toBe("ready");
    expect(http.mock.calls[0][0]).toContain(creds[0].token);
  });
});
