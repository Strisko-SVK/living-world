import { z } from "zod";
import type { RaonConfig } from "../../llm/config.js";
import {
  ProviderFailure,
  type ProviderRequest,
  type TextProvider,
} from "../../llm/contracts.js";

const templateSchema = z.object({ prompt: z.string().min(1) });
const tokenSchema = z.object({
  tokens: z.array(z.number().int().nonnegative()).min(1),
});
const count = z.number().int().safe().nonnegative();
const completionSchema = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({
          role: z.literal("assistant"),
          content: z.string(),
          tool_calls: z.undefined().optional(),
          reasoning_content: z.union([z.literal(""), z.null()]).optional(),
        }),
      }),
    )
    .length(1),
  timings: z.unknown().optional(),
  usage: z.object({
    prompt_tokens: count,
    completion_tokens: count,
    total_tokens: count,
  }),
});

// Timing fields are optional runtime observations, never inferred from wall time.
const timingsSchema = z.object({
  prompt_ms: z.number().finite().nonnegative().optional(),
  predicted_ms: z.number().finite().nonnegative().optional(),
  prompt_per_second: z.number().finite().nonnegative().optional(),
  predicted_per_second: z.number().finite().nonnegative().optional(),
});

export function createRaonProvider(
  config: RaonConfig,
  http = fetch,
): TextProvider {
  async function post<T>(
    path: string,
    body: object,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ) {
    const url = config.baseUrl + path;
    let response: Response;
    try {
      response = await http(url, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new ProviderFailure("unavailable");
    }
    if (response.redirected || (response.url && response.url !== url))
      throw new ProviderFailure("unavailable");
    if (!response.ok) {
      if (response.status === 429) throw new ProviderFailure("rate_limit");
      if (response.status === 400 && path === "/v1/chat/completions")
        throw new ProviderFailure("unsupported_output");
      throw new ProviderFailure("unavailable");
    }
    try {
      return schema.parse(await response.json());
    } catch {
      throw new ProviderFailure("invalid_response");
    }
  }

  function chat(request: ProviderRequest) {
    if (request.model !== config.model)
      throw new ProviderFailure("invalid_request");
    const system = request.messages.filter(
      (message) => message.role !== "user",
    );
    const user = request.messages.filter((message) => message.role === "user");
    return {
      model: request.model,
      messages: [
        {
          role: "system",
          content: system.map((message) => message.content).join("\n\n"),
        },
        // Escape delimiter characters so runtime special-token parsing cannot
        // turn player text into a template boundary. Pilot data is JSON.
        ...user.map(({ role, content }) => ({
          role,
          content: content.replace(/[<>]/gu, (char) =>
            char === "<" ? "\\u003c" : "\\u003e",
          ),
        })),
      ],
      chat_template_kwargs: { enable_thinking: config.thinkingEnabled },
      ...(request.responseFormat && {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: request.responseFormat.name,
            strict: true,
            schema: request.responseFormat.schema,
          },
        },
      }),
    };
  }

  return {
    supportsStructuredOutput: true,
    async countInput(request, signal) {
      const { prompt } = await post(
        "/apply-template",
        chat(request),
        templateSchema,
        signal,
      );
      const { tokens } = await post(
        "/tokenize",
        { content: prompt, add_special: true, parse_special: true },
        tokenSchema,
        signal,
      );
      return tokens.length;
    },
    async generate(request, signal) {
      const result = await post(
        "/v1/chat/completions",
        {
          ...chat(request),
          stream: false,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature ?? config.temperature,
          presence_penalty: config.presencePenalty,
          ...(config.provider === "local"
            ? { top_p: config.topP, top_k: config.topK, min_p: config.minP }
            : {}),
        },
        completionSchema,
        signal,
      );
      if (result.model !== config.model)
        throw new ProviderFailure("invalid_response");
      const { prompt_tokens, completion_tokens, total_tokens } = result.usage;
      const timings = timingsSchema.safeParse(result.timings);
      return {
        text: result.choices[0].message.content,
        completed: result.choices[0].finish_reason === "stop",
        ...(timings.success && {
          timings: {
            promptEvaluationMs: timings.data.prompt_ms,
            outputGenerationMs: timings.data.predicted_ms,
            promptTokensPerSecond: timings.data.prompt_per_second,
            outputTokensPerSecond: timings.data.predicted_per_second,
          },
        }),
        usage: {
          inputTokens: prompt_tokens,
          outputTokens: completion_tokens,
          totalTokens: total_tokens,
        },
      };
    },
  };
}
