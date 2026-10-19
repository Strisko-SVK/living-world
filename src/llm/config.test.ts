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
});
