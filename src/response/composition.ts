import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import { getInteraction } from "../domains/interaction/interaction.repository.js";
import { createNpcContextBuilder } from "../context/context.repository.js";
import { createLlmService } from "../llm/composition.js";
import { createNpcResponseOrchestrator } from "./orchestrator.js";
import { createResponseStore } from "./response.repository.js";
import type { ResponseDiagnostic } from "./contracts.js";

export function createNpcResponsePipeline(
  database: DatabaseClient["db"],
  environment: NodeJS.ProcessEnv = process.env,
  diagnose?: (event: ResponseDiagnostic) => void,
) {
  const store = createResponseStore(database);
  return {
    generateNpcResponse: createNpcResponseOrchestrator(
      {
        read: (s) =>
          getInteraction(database, s.worldId, s.npcId, s.interactionId),
        build: createNpcContextBuilder(database),
        store,
        generate: createLlmService(database, environment),
      },
      diagnose,
    ),
    reconcileNpcResponse: (
      worldId: string,
      npcId: string,
      interactionId: string,
    ) => {
      for (const id of [worldId, npcId, interactionId])
        z.string().uuid().parse(id);
      return store.reconcile({ worldId, npcId, interactionId });
    },
  };
}
