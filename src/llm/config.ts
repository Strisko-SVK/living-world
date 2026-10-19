import { z } from "zod";

const integer = (max: number) => z.coerce.number().int().positive().max(max);
const schema = z.object({
  LLM_PROVIDER: z.enum(["disabled", "openai"]).default("disabled"),
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
export type EnabledLlmConfig = Extract<LlmConfig, { enabled: true }>;
