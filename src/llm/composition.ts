import type { DatabaseClient } from "../db/client.js";
import { getLlmConfig } from "./config.js";
import { createBudgetStore } from "./budget.repository.js";
import { createOpenAiProvider } from "../adapters/openai/provider.js";
import { createRaonProvider } from "../adapters/raon/provider.js";
import { createTextGenerator } from "./generation.js";
import type { Observation, TextProvider } from "./contracts.js";

// Explicit construction only. Neither startup nor intake invokes generation.
export function createLlmService(
  database: Omit<DatabaseClient["db"], "$client">,
  environment: NodeJS.ProcessEnv = process.env,
  diagnose?: (event: Observation) => void,
  inferenceHttp?: typeof fetch,
) {
  const config = getLlmConfig(environment);
  const disabled: TextProvider = {
    countInput: async () => {
      throw new Error("LLM disabled.");
    },
    generate: async () => {
      throw new Error("LLM disabled.");
    },
  };
  return createTextGenerator(
    config,
    config.enabled
      ? config.provider === "raon"
        ? createRaonProvider(config, inferenceHttp)
        : createOpenAiProvider(config)
      : disabled,
    createBudgetStore(database),
    diagnose,
  );
}
