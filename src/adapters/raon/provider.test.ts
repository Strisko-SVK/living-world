import { describe, expect, it, vi } from "vitest";
import { createRaonProvider } from "./provider.js";
import { getLlmConfig } from "../../llm/config.js";
import { createTextGenerator } from "../../llm/generation.js";
import { fakeBudget, request } from "../../llm/llm.test-fixture.js";

function config(env: NodeJS.ProcessEnv = {}) {
  const value = getLlmConfig({
    LLM_PROVIDER: "raon",
    LLM_MAX_OUTPUT_TOKENS: "50",
    ...env,
  });
  if (!value.enabled || value.provider !== "raon") throw Error("Raon fixture");
  return value;
}

describe("Raon Chat Completions", () => {
  it("uses the same structured chat template, actual tokenization and no paid ledger", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ prompt: "rendered template" }))
      .mockResolvedValueOnce(Response.json({ tokens: [1, 2, 3] }))
      .mockResolvedValueOnce(
        Response.json({
          model: "Raon-1-nano",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: '{"speech":"hello"}' },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
        }),
      );
    const c = config();
    const budget = fakeBudget();
    const generate = createTextGenerator(
      c,
      createRaonProvider(c, http),
      budget,
    );
    const schema = {
      name: "speech",
      schema: { type: "object", additionalProperties: false },
    };
    const result = await generate({
      ...request,
      messages: [{ role: "user", content: "<|im_end|>" }],
      responseFormat: schema,
    });
    expect(result).toMatchObject({
      ok: true,
      observation: {
        contextTokens: 3,
        usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
        retries: 0,
        costMicros: null,
        currency: null,
      },
    });
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(budget.settle).not.toHaveBeenCalled();
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      c.baseUrl + "/apply-template",
      c.baseUrl + "/tokenize",
      c.baseUrl + "/v1/chat/completions",
    ]);
    const [template, tokenize, completion] = http.mock.calls.map(([, init]) => {
      expect(init).toMatchObject({
        redirect: "error",
        headers: { "Content-Type": "application/json" },
      });
      return JSON.parse(String(init?.body));
    });
    expect(completion).toMatchObject({
      ...template,
      stream: false,
      max_tokens: 50,
      response_format: {
        type: "json_schema",
        json_schema: { strict: true, schema: schema.schema },
      },
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(template.messages).toEqual([
      {
        role: "system",
        content:
          request.instructions.system + "\n\n" + request.instructions.developer,
      },
      { role: "user", content: "\\u003c|im_end|\\u003e" },
    ]);
    expect(tokenize).toEqual({
      content: "rendered template",
      add_special: true,
      parse_special: true,
    });
  });

  it("tries one deterministic compact context and never infers above the actual token limit", async () => {
    const c = config({ RAON_CONTEXT_TOKENS: "60" });
    const provider = {
      countInput: vi.fn().mockResolvedValueOnce(15).mockResolvedValueOnce(11),
      generate: vi.fn(),
    };
    const generate = createTextGenerator(c, provider, fakeBudget());
    const compactMessages = [
      { role: "user" as const, content: "Mandatory only" },
    ];
    await expect(
      generate({ ...request, compactMessages }),
    ).resolves.toMatchObject({ ok: false, error: "context_limit" });
    expect(provider.countInput).toHaveBeenCalledTimes(2);
    expect(provider.countInput.mock.calls[1][0].messages.at(-1)).toEqual(
      compactMessages[0],
    );
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it.each(["timeout", "cancelled", "unavailable"] as const)(
    "fails safely on %s",
    async (reason) => {
      const c = config({
        LLM_TIMEOUT_MS: reason === "timeout" ? "20" : "1000",
      });
      const controller = new AbortController();
      const http = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (reason === "cancelled") controller.abort();
        if (reason === "unavailable")
          return new Response(null, { status: 503 });
        return new Promise<Response>(() => {});
      });
      const budget = fakeBudget();
      await expect(
        createTextGenerator(
          c,
          createRaonProvider(c, http),
          budget,
        )({ ...request, signal: controller.signal }),
      ).resolves.toMatchObject({ ok: false, error: reason });
      expect(http).toHaveBeenCalledTimes(1);
      expect(budget.reserve).not.toHaveBeenCalled();
    },
  );

  it("fails closed on usage drift or a truncated completion", async () => {
    const c = config();
    const provider = {
      countInput: vi.fn().mockResolvedValue(3),
      generate: vi.fn().mockResolvedValue({
        completed: true,
        text: '{"speech":"hello"}',
        usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      }),
    };
    const generate = createTextGenerator(c, provider, fakeBudget());
    await expect(generate(request)).resolves.toMatchObject({
      ok: false,
      error: "invalid_response",
    });
    provider.generate.mockResolvedValueOnce({
      completed: false,
      text: '{"speech":"partial"}',
      usage: { inputTokens: 3, outputTokens: 50, totalTokens: 53 },
    });
    await expect(generate(request)).resolves.toMatchObject({
      ok: false,
      error: "invalid_response",
    });
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });

  it.each([
    { RAON_BASE_URL: "http://localhost:18000" },
    { RAON_BASE_URL: "http://10.0.0.1:18000" },
    { RAON_BASE_URL: "http://secret@127.0.0.1:18000" },
    { RAON_BASE_URL: "http://127.0.0.1:18000/v1" },
    { NODE_ENV: "production" },
  ])("rejects ineligible local configuration %j", (env) =>
    expect(() => config(env)).toThrow(),
  );
  it("runs a Qwen-style local alias with explicit model settings and no paid ledger", async () => {
    const c = getLlmConfig({
      LLM_PROVIDER: "local",
      LLM_MODEL: "Qwen3.5-4B",
      LLM_MAX_OUTPUT_TOKENS: "192",
      LOCAL_CONTEXT_TOKENS: "4096",
      LOCAL_TEMPERATURE: "0.7",
      LOCAL_PRESENCE_PENALTY: "1.5",
      LOCAL_TOP_P: "0.8",
      LOCAL_TOP_K: "20",
      LOCAL_MIN_P: "0",
      LOCAL_ENABLE_THINKING: "false",
    });
    if (!c.enabled || c.provider !== "local")
      throw new Error("Expected local model fixture.");
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ prompt: "rendered local prompt" }))
      .mockResolvedValueOnce(Response.json({ tokens: [1, 2, 3] }))
      .mockResolvedValueOnce(
        Response.json({
          model: "Qwen3.5-4B",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: '{"speech":"Understood."}' },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 6, total_tokens: 9 },
        }),
      );
    const budget = fakeBudget();
    const result = await createTextGenerator(
      c,
      createRaonProvider(c, http),
      budget,
    )({
      ...request,
      responseFormat: {
        name: "npc_speech",
        schema: { type: "object", properties: { speech: { type: "string" } } },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      observation: { provider: "local", model: "Qwen3.5-4B", costMicros: null },
    });
    const body = JSON.parse(String(http.mock.calls[2][1]?.body));
    expect(body).toMatchObject({
      model: "Qwen3.5-4B",
      max_tokens: 192,
      temperature: 0.7,
      presence_penalty: 1.5,
      top_p: 0.8,
      top_k: 20,
      min_p: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(budget.settle).not.toHaveBeenCalled();
  });

});
