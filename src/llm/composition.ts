import type { DatabaseClient } from "../db/client.js";
import { getLlmConfig } from "./config.js";
import { createBudgetStore } from "./budget.repository.js";
import { createOpenAiProvider } from "../adapters/openai/provider.js";
import { createTextGenerator } from "./generation.js";
import type { Observation, TextProvider } from "./contracts.js";

// Explicit construction only. Neither startup nor intake invokes generation.
export function createLlmService(
  database: DatabaseClient["db"],
  environment: NodeJS.ProcessEnv = process.env,
  diagnose?: (event: Observation) => void,
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
    config.enabled ? createOpenAiProvider(config) : disabled,
    createBudgetStore(database),
    diagnose,
  );
}
