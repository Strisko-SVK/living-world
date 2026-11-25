import { describe, expect, it } from "vitest";
import { getLlmConfig } from "./config.js";
import { environment } from "./llm.test-fixture.js";
import { getApplicationConfig } from "../config.js";

describe("LLM configuration", () => {
  it("selects disabled by default and composes application configuration", () => {
    expect(getApplicationConfig({}).llm).toEqual({ enabled: false });
    expect(getLlmConfig(environment)).toMatchObject({
      enabled: true,
      provider: "openai",
      monthlyMicros: 5000000n,
    });
  });
  it.each([
    { LLM_PROVIDER: "other" },
    { OPENAI_API_KEY: undefined },
    { OPENAI_API_KEY: "secret key" },
    { LLM_MODEL: undefined },
    { LLM_CURRENCY: undefined },
    { LLM_PRICE_CURRENCY: "EUR" },
    { LLM_MONTHLY_BUDGET_MICROS: undefined },
    { LLM_MONTHLY_BUDGET_MICROS: "0" },
    { LLM_MONTHLY_BUDGET_MICROS: "15000000" },
    { LLM_INPUT_MICROS_PER_MILLION: undefined },
    { LLM_OUTPUT_MICROS_PER_MILLION: "-1" },
    { LLM_TIMEOUT_MS: "Infinity" },
    { LLM_MAX_ATTEMPTS: "4" },
    { LLM_MAX_OUTPUT_TOKENS: "0" },
    { LLM_REQUEST_BUDGET_MICROS: "1.2" },
  ])("fails closed for invalid configuration %j", (override) => {
    expect(() => getLlmConfig({ ...environment, ...override })).toThrow();
    try {
      getLlmConfig({ ...environment, ...override });
    } catch (error) {
      expect(String(error)).not.toContain("synthetic-offline-key");
      expect(String(error)).not.toContain("secret key");
    }
  });
  it("supports EUR only with explicitly EUR-denominated prices, without conversion", () => {
    expect(
      getLlmConfig({
        ...environment,
        LLM_CURRENCY: "EUR",
        LLM_PRICE_CURRENCY: "EUR",
      }),
    ).toMatchObject({ currency: "EUR" });
  });
  it("supports explicit model-independent loopback inference while keeping RAON defaults", () => {
    const legacy = getLlmConfig({ LLM_PROVIDER: "raon" });
    expect(legacy).toMatchObject({
      provider: "raon",
      model: "Raon-1-nano",
      temperature: 0.1,
      thinkingEnabled: false,
      presencePenalty: 0,
    });
    const local = getLlmConfig({
      LLM_PROVIDER: "local",
      LLM_MODEL: "Qwen3.5-4B",
      LOCAL_CONTEXT_TOKENS: "4096",
      LOCAL_TEMPERATURE: "0.7",
      LOCAL_PRESENCE_PENALTY: "1.5",
      LOCAL_TOP_P: "0.8",
      LOCAL_TOP_K: "20",
      LOCAL_MIN_P: "0",
    });
    expect(local).toMatchObject({
      enabled: true,
      provider: "local",
      model: "Qwen3.5-4B",
      temperature: 0.7,
      presencePenalty: 1.5,
      topP: 0.8,
      topK: 20,
      minP: 0,
      thinkingEnabled: false,
      maxAttempts: 1,
    });
  });
  it.each([
    { LLM_MODEL: undefined },
    { LLM_MODEL: "Qwen3.5-4B", LOCAL_BASE_URL: "http://localhost:18000" },
    { LLM_MODEL: "Qwen3.5-4B", LOCAL_BASE_URL: "http://192.0.2.1:8000" },
    { LLM_MODEL: "Qwen3.5-4B", LOCAL_BASE_URL: "https://127.0.0.1:18000" },
    { LLM_MODEL: "Qwen3.5-4B", LOCAL_TEMPERATURE: "Infinity" },
    { LLM_MODEL: "Qwen3.5-4B", LOCAL_PRESENCE_PENALTY: "3" },
    { LLM_MODEL: "Qwen3.5-4B", LOCAL_ENABLE_THINKING: "maybe" },
    { LLM_MODEL: "Qwen3.5-4B", LOCAL_CONTEXT_TOKENS: "128" },
  ])("rejects unsafe or incompatible local inference settings %j", (change) => {
    expect(() =>
      getLlmConfig({
        LLM_PROVIDER: "local",
        LLM_MAX_OUTPUT_TOKENS: "192",
        ...change,
      }),
    ).toThrow();
  });

});
