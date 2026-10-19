import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenAiProvider,
  normalizeError,
  normalizeUsage,
} from "./provider.js";
import { enabledConfig } from "../../llm/llm.test-fixture.js";
import type { ProviderRequest } from "../../llm/contracts.js";

const request: ProviderRequest = {
  model: "synthetic-model",
  maxOutputTokens: 100,
  messages: [
    { role: "system", content: "trusted" },
    { role: "developer", content: "policy" },
    { role: "user", content: "untrusted" },
  ],
};
const signal = () => new AbortController().signal;
function fixture(
  status = 200,
  body: unknown = { input_tokens: 12 },
  headers?: HeadersInit,
) {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );
  const sdk = new OpenAI({
    apiKey: "synthetic-offline",
    fetch,
    maxRetries: 0,
    logLevel: "off",
  });
  return { fetch, provider: createOpenAiProvider(enabledConfig(), sdk) };
}
describe("OpenAI SDK transport boundary (fake fetch only)", () => {
  it("treats exhausted provider quota as permanent rather than retryable", () => {
    expect(
      normalizeError(
        new OpenAI.RateLimitError(
          429,
          { code: "insufficient_quota" },
          "private",
          new Headers(),
        ),
      ),
    ).toMatchObject({
      code: "budget",
      retryable: false,
      definitelyUnbilled: true,
    });
  });
  it("does not connect on construction and preflights exact role-separated input", async () => {
    const { provider, fetch } = fixture();
    expect(fetch).not.toHaveBeenCalled();
    expect(await provider.countInput(request, signal())).toBe(12);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain("/responses/input_tokens");
    const body = JSON.parse(init.body);
    expect(body.input).toEqual(request.messages);
    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBe("none");
  });
  it("uses Responses text-only, no persistence, tools, background tasks or hidden retries", async () => {
    const { provider, fetch } = fixture(200, {
      object: "response",
      id: "resp_synthetic",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Offline generated text",
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    });
    const reply = await provider.generate(request, signal());
    expect(reply).toMatchObject({
      completed: true,
      text: "Offline generated text",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: "synthetic-model",
      max_output_tokens: 100,
      store: false,
      background: false,
      service_tier: "default",
      tools: [],
      tool_choice: "none",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [401, "authentication", false],
    [403, "authentication", false],
    [400, "invalid_request", false],
    [422, "invalid_request", false],
    [429, "rate_limit", true],
    [500, "unavailable", true],
    [408, "unavailable", true],
  ])(
    "normalizes HTTP %s without SDK errors or bodies escaping",
    async (status, code, retryable) => {
      const { provider, fetch } = fixture(
        status as number,
        { error: { message: "secret provider body", type: "synthetic" } },
        { "retry-after": "2" },
      );
      await expect(provider.generate(request, signal())).rejects.toMatchObject({
        code,
        retryable,
        message: "Text provider request failed.",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("normalizes token usage and makes missing/inconsistent usage explicit", () => {
    expect(
      normalizeUsage({ input_tokens: 2, output_tokens: 3, total_tokens: 5 }),
    ).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    for (const value of [
      null,
      {},
      { input_tokens: 1, output_tokens: 2 },
      { input_tokens: 1, output_tokens: 2, total_tokens: 4 },
      { input_tokens: -1, output_tokens: 2, total_tokens: 1 },
    ])
      expect(normalizeUsage(value)).toBeNull();
  });
  it("honors millisecond and HTTP-date retry guidance", () => {
    const error = new OpenAI.RateLimitError(
      429,
      undefined,
      "private",
      new Headers({ "retry-after-ms": "1234" }),
    );
    expect(normalizeError(error)).toMatchObject({
      retryAfterMs: 1234,
      definitelyUnbilled: true,
    });
    const date = new Date(Date.now() + 20000).toUTCString();
    expect(
      normalizeError(
        new OpenAI.RateLimitError(
          429,
          undefined,
          "private",
          new Headers({ "retry-after": date }),
        ),
      ).retryAfterMs,
    ).toBeGreaterThan(18000);
  });
  it("rejects invalid preflight metadata", async () => {
    const { provider } = fixture(200, { input_tokens: -1 });
    await expect(provider.countInput(request, signal())).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
  it("normalizes connection, timeout, abort and unknown exceptions", () => {
    expect(
      normalizeError(new OpenAI.APIConnectionError({ message: "private" })),
    ).toMatchObject({ code: "unavailable", retryable: true });
    expect(
      normalizeError(new OpenAI.APIConnectionTimeoutError()),
    ).toMatchObject({ code: "timeout", retryable: false });
    expect(normalizeError(new OpenAI.APIUserAbortError())).toMatchObject({
      code: "cancelled",
    });
    expect(normalizeError(Error("private"))).toMatchObject({
      code: "unavailable",
      retryable: false,
    });
  });
});
