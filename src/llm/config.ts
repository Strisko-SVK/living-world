import { z } from "zod";

const integer = (max: number) => z.coerce.number().int().positive().max(max);
const schema = z.object({
  LLM_PROVIDER: z.enum(["disabled", "openai", "raon", "local"]).default("disabled"),
  RAON_BASE_URL: z.string().default("http://127.0.0.1:18000"),
  RAON_CONTEXT_TOKENS: integer(4096).default(4096),
  LOCAL_BASE_URL: z.string().default("http://127.0.0.1:18000"),
  LOCAL_CONTEXT_TOKENS: integer(32768).default(4096),
  LOCAL_TEMPERATURE: z.coerce.number().finite().min(0).max(2).default(0.1),
  LOCAL_PRESENCE_PENALTY: z.coerce.number().finite().min(-2).max(2).default(0),
  LOCAL_TOP_P: z.coerce.number().finite().min(0).max(1).default(1),
  LOCAL_TOP_K: z.coerce.number().int().min(0).max(1000).default(40),
  LOCAL_MIN_P: z.coerce.number().finite().min(0).max(1).default(0),
  LOCAL_ENABLE_THINKING: z.enum(["true", "false"]).default("false"),
  OPENAI_API_KEY: z.string().regex(/^\S+$/).optional(),
  LLM_MODEL: z
    .string()
    .regex(/^[a-zA-Z0-9._:-]{1,120}$/)
    .optional(),
  LLM_TIMEOUT_MS: integer(120_000).default(30_000),
  LLM_MAX_OUTPUT_TOKENS: integer(32_768).default(512),
  LLM_MAX_ATTEMPTS: integer(3).default(2),
  LLM_MONTHLY_BUDGET_MICROS: integer(10_000_000).optional(),
  LLM_REQUEST_BUDGET_MICROS: integer(10_000_000).optional(),
  LLM_CURRENCY: z.enum(["USD", "EUR"]).optional(),
  LLM_PRICE_CURRENCY: z.enum(["USD", "EUR"]).optional(),
  LLM_INPUT_MICROS_PER_MILLION: integer(1_000_000_000).optional(),
  LLM_OUTPUT_MICROS_PER_MILLION: integer(1_000_000_000).optional(),
});
export function getLlmConfig(environment: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(environment);
  if (!result.success) throw new Error("Invalid LLM configuration.");
  const e = result.data;
  if (e.LLM_PROVIDER === "disabled") return { enabled: false as const };
  if (e.LLM_PROVIDER === "raon" || e.LLM_PROVIDER === "local") {
    const isLocal = e.LLM_PROVIDER === "local";
    const baseUrl = new URL(isLocal ? e.LOCAL_BASE_URL : e.RAON_BASE_URL);
    const contextTokens = isLocal
      ? e.LOCAL_CONTEXT_TOKENS
      : e.RAON_CONTEXT_TOKENS;
    if (
      environment.NODE_ENV === "production" ||
      baseUrl.protocol !== "http:" ||
      baseUrl.hostname !== "127.0.0.1" ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.pathname !== "/" ||
      baseUrl.search ||
      baseUrl.hash ||
      !baseUrl.port ||
      e.LLM_MAX_OUTPUT_TOKENS >= contextTokens
    )
      throw new Error(
        "Local inference requires a loopback DEV endpoint and room for input.",
      );
    if (isLocal && !e.LLM_MODEL)
      throw new Error("Local inference requires an explicit model alias.");
    return {
      enabled: true as const,
      provider: e.LLM_PROVIDER,
      baseUrl: baseUrl.origin,
      model: e.LLM_MODEL ?? "Raon-1-nano",
      contextTokens,
      temperature: isLocal ? e.LOCAL_TEMPERATURE : 0.1,
      presencePenalty: isLocal ? e.LOCAL_PRESENCE_PENALTY : 0,
      topP: isLocal ? e.LOCAL_TOP_P : 1,
      topK: isLocal ? e.LOCAL_TOP_K : 40,
      minP: isLocal ? e.LOCAL_MIN_P : 0,
      thinkingEnabled: isLocal && e.LOCAL_ENABLE_THINKING === "true",
      timeoutMs: e.LLM_TIMEOUT_MS,
      maxOutputTokens: e.LLM_MAX_OUTPUT_TOKENS,
      maxAttempts: 1,
    };
  }
  if (
    !e.OPENAI_API_KEY ||
    !e.LLM_MODEL ||
    !e.LLM_CURRENCY ||
    e.LLM_CURRENCY !== e.LLM_PRICE_CURRENCY ||
    !e.LLM_MONTHLY_BUDGET_MICROS ||
    !e.LLM_INPUT_MICROS_PER_MILLION ||
    !e.LLM_OUTPUT_MICROS_PER_MILLION
  )
    throw new Error(
      "Enabled LLM requires credentials, model, explicit matching currencies, pricing and a monthly ceiling.",
    );
  return {
    enabled: true as const,
    provider: "openai" as const,
    apiKey: e.OPENAI_API_KEY,
    model: e.LLM_MODEL,
    timeoutMs: e.LLM_TIMEOUT_MS,
    maxOutputTokens: e.LLM_MAX_OUTPUT_TOKENS,
    maxAttempts: e.LLM_MAX_ATTEMPTS,
    currency: e.LLM_CURRENCY,
    monthlyMicros: BigInt(e.LLM_MONTHLY_BUDGET_MICROS),
    requestMicros:
      e.LLM_REQUEST_BUDGET_MICROS === undefined
        ? undefined
        : BigInt(e.LLM_REQUEST_BUDGET_MICROS),
    inputRate: BigInt(e.LLM_INPUT_MICROS_PER_MILLION),
    outputRate: BigInt(e.LLM_OUTPUT_MICROS_PER_MILLION),
  };
}
export type LlmConfig = ReturnType<typeof getLlmConfig>;
export type EnabledLlmConfig = Extract<LlmConfig, { provider: "openai" }>;
export type LocalInferenceConfig = Extract<
  LlmConfig,
  { provider: "raon" | "local" }
>;
// Backwards-compatible alias for the existing llama.cpp adapter.
export type RaonConfig = LocalInferenceConfig;
