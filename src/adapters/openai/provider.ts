import OpenAI from "openai";
import type { EnabledLlmConfig } from "../../llm/config.js";
import {
  ProviderFailure,
  type ProviderRequest,
  type TextProvider,
  type Usage,
} from "../../llm/contracts.js";

export function normalizeUsage(value: unknown): Usage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const values = [v.input_tokens, v.output_tokens, v.total_tokens];
  if (
    !values.every(
      (n) =>
        typeof n === "number" &&
        Number.isSafeInteger(n) &&
        n >= 0 &&
        n <= 2_000_000_000,
    )
  )
    return null;
  const [inputTokens, outputTokens, totalTokens] = values as number[];
  return totalTokens === inputTokens + outputTokens
    ? { inputTokens, outputTokens, totalTokens }
    : null;
}
export function normalizeError(error: unknown): ProviderFailure {
  if (error instanceof ProviderFailure) return error;
  if (error instanceof OpenAI.APIUserAbortError)
    return new ProviderFailure("cancelled");
  if (error instanceof OpenAI.APIConnectionTimeoutError)
    return new ProviderFailure("timeout");
  if (!(error instanceof OpenAI.APIError))
    return new ProviderFailure("unavailable");
  const status = error.status;
  if (status === 401 || status === 403)
    return new ProviderFailure("authentication", false, undefined, true);
  if (status === 400 || status === 404 || status === 422)
    return new ProviderFailure("invalid_request", false, undefined, true);
  if (status === 429 && error.code === "insufficient_quota")
    return new ProviderFailure("budget", false, undefined, true);
  const ms = error.headers?.get("retry-after-ms"),
    retry = error.headers?.get("retry-after");
  let delay = ms ? Number(ms) : retry ? Number(retry) * 1000 : undefined;
  if (retry && !Number.isFinite(delay)) delay = Date.parse(retry) - Date.now();
  if (delay !== undefined && (!Number.isFinite(delay) || delay < 0))
    delay = undefined;
  return new ProviderFailure(
    status === 429 ? "rate_limit" : "unavailable",
    status === 408 ||
      status === 409 ||
      status === 429 ||
      (status !== undefined && status >= 500) ||
      error instanceof OpenAI.APIConnectionError,
    delay,
    status === 429,
  );
}
// Injectable SDK client permits wire-format tests using a fake fetch. No calls at
// construction/import, no alternate base URL, no SDK logging or hidden retries.
export function createOpenAiProvider(
  config: EnabledLlmConfig,
  sdk?: OpenAI,
): TextProvider {
  const client =
    sdk ??
    new OpenAI({
      apiKey: config.apiKey,
      baseURL: "https://api.openai.com/v1",
      maxRetries: 0,
      timeout: config.timeoutMs,
      logLevel: "off",
      organization: null,
      project: null,
    });
  const input = (request: ProviderRequest) => ({
    model: request.model,
    input: request.messages,
    tools: [],
    tool_choice: "none" as const,
    truncation: "disabled" as const,
  });
  return {
    async countInput(request, signal) {
      try {
        const response = await client.responses.inputTokens.count(
          input(request),
          { signal, maxRetries: 0 },
        );
        if (
          !Number.isSafeInteger(response.input_tokens) ||
          response.input_tokens < 0 ||
          response.input_tokens > 2_000_000_000
        )
          throw new ProviderFailure("invalid_response");
        return response.input_tokens;
      } catch (error) {
        throw normalizeError(error);
      }
    },
    async generate(request, signal) {
      try {
        const response = await client.responses.create(
          {
            ...input(request),
            max_output_tokens: request.maxOutputTokens,
            temperature: request.temperature,
            service_tier: "default",
            store: false,
            background: false,
          },
          { signal, maxRetries: 0 },
        );
        return {
          text: response.output_text ?? "",
          usage: normalizeUsage(response.usage),
          requestId: response._request_id ?? undefined,
          completed:
            response.status === "completed" &&
            response.output.every(
              (item) => item.type === "message" || item.type === "reasoning",
            ),
        };
      } catch (error) {
        throw normalizeError(error);
      }
    },
  };
}
