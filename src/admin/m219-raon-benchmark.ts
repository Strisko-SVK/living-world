import { pathToFileURL } from "node:url";
import { createRaonProvider } from "../adapters/raon/provider.js";
import { getLlmConfig } from "../llm/config.js";
import { createTextGenerator } from "../llm/generation.js";
import { dialogueCases, dialogueDatasetVersion } from "./m219-dialogue-cases.js";
import { runDialogueBenchmark } from "./m219-dialogue-benchmark.js";

export async function runM219Benchmark(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  if (args.length > 2 || (args.length && args[0] !== "--case"))
    throw new Error("Use no arguments or --case <scenario ID>.");
  const cases = args.length
    ? dialogueCases.filter((scenario) => scenario.id === args[1])
    : dialogueCases;
  if (!cases.length) throw new Error("Unknown benchmark scenario.");

  const config = getLlmConfig({
    ...env,
    LLM_PROVIDER: "raon",
    LLM_MAX_OUTPUT_TOKENS: env.RAON_DEV_OUTPUT_TOKENS ?? "192",
  });
  if (!config.enabled || config.provider !== "raon" || config.contextTokens !== 4096)
    throw new Error("Benchmark requires the existing loopback RAON 4096 configuration.");

  const prompt = env.RAON_BENCH_PROMPT ?? "baseline";
  if (prompt !== "baseline" && prompt !== "m219-v1")
    throw new Error("Invalid benchmark prompt version.");
  const temperature = Number(env.RAON_BENCH_TEMPERATURE ?? "0.1");
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
    throw new Error("Invalid benchmark temperature.");

  // No DB, no Discord connection, no paid provider. The budget interface is
  // mandatory for the shared generator but must never be used by RAON.
  const generate = createTextGenerator(config, createRaonProvider(config), {
    reserve: async () => {
      throw new Error("Benchmark cannot reserve paid usage.");
    },
    settle: async () => {
      throw new Error("Benchmark cannot settle paid usage.");
    },
  });

  const write = (record: Record<string, unknown>) =>
    console.info(JSON.stringify(record));
  write({
    event: "m219_benchmark_config",
    datasetVersion: dialogueDatasetVersion,
    configuredModel: config.model,
    contextTokens: config.contextTokens,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    temperature,
    prompt,
    presencePenalty: 0,
    thinking: false,
    quantization: env.RAON_BENCH_QUANTIZATION ?? "operator_evidence_required",
    runtimeRevision: env.RAON_BENCH_RUNTIME_REVISION ?? "operator_evidence_required",
    runtimeConfiguration: env.RAON_BENCH_RUNTIME_CONFIG ?? "operator_evidence_required",
    metadataSource: "operator_supplied_or_unknown",
    seed: "not_configured",
    scenarios: cases.length,
  });
  await runDialogueBenchmark(generate, { signal, cases, temperature, candidate: prompt === "m219-v1", write });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  void runM219Benchmark(process.argv.slice(2), process.env, controller.signal)
    .catch(() => {
      console.error("M2.19 benchmark stopped or failed; inspect local RAON settings.");
      process.exitCode = 1;
    })
    .finally(() => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    });
}
