import type { DatabaseClient } from "../db/client.js";
import { getInteraction } from "../domains/interaction/interaction.repository.js";
import { createNpcContextBuilder } from "../context/context.repository.js";
import { createResponseStore } from "../response/response.repository.js";
import { createNpcResponseOrchestrator } from "../response/orchestrator.js";
import { createTextGenerator } from "../llm/generation.js";
import { enabledConfig, fakeBudget, fakeProvider } from "../llm/llm.test-fixture.js";
import { createDeliveryRepository } from "../delivery/delivery.repository.js";
import { createDeliveryDispatcher } from "../delivery/dispatch.js";
import { fakeDeliveryTransport } from "../delivery/delivery.test-fixture.js";
import { createOfflineNpcWorkflow } from "./npc-e2e.js";
import type { ResponseScope } from "../response/contracts.js";

// Test-file-only composition. Never import into runtime, admin CLIs, or workers.
// All provider and transport instances are created here, not caller-injected.
export async function createOfflineNpcTestHarness(
  database: DatabaseClient,
  worldId: string,
) {
  const url = process.env.DATABASE_URL;
  if (process.env.NODE_ENV !== "test" || !url)
    throw Error("Offline harness requires the test runner and isolated DB.");
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !["/living_world_ci", "/living_world_test"].includes(parsed.pathname) ||
    process.env.DISCORD_ENABLED === "true" ||
    process.env.LLM_PROVIDER === "openai"
  )
    throw Error("Offline harness refuses an unsafe database or provider.");

  // Verify the *actual* database session and synthetic world, not only env vars.
  const { rows } = await database.pool.query<{
    database_name: string;
    world_key: string | null;
  }>(
    "select current_database() as database_name, (select key from worlds where id=$1) as world_key",
    [worldId],
  );
  if (
    rows.length !== 1 ||
    !["living_world_ci", "living_world_test"].includes(rows[0]!.database_name) ||
    !/^delivery-test-[0-9a-f-]{36}$/.test(rows[0]!.world_key ?? "")
  )
    throw Error("Offline harness requires a disposable synthetic world.");

  const read = (scope: ResponseScope) =>
    getInteraction(
      database.db,
      scope.worldId,
      scope.npcId,
      scope.interactionId,
    );
  const provider = fakeProvider();
  const budget = fakeBudget();
  const transport = fakeDeliveryTransport(new Set([worldId]));
  const repository = createDeliveryRepository(database.db);
  const dispatch = createDeliveryDispatcher(repository, transport);
  const response = createNpcResponseOrchestrator({
    read,
    build: createNpcContextBuilder(database.db),
    store: createResponseStore(database.db),
    generate: createTextGenerator(enabledConfig(), provider, budget),
  });
  const run = createOfflineNpcWorkflow({
    read,
    generate: (scope) =>
      response(scope.worldId, scope.npcId, scope.interactionId),
    deliver: async (scope) => {
      if (scope.worldId !== worldId) return "blocked";
      const prepared = await repository.prepare(scope);
      if (prepared.status !== "prepared" && prepared.status !== "existing")
        return "blocked";
      const result = await dispatch(scope);
      return result.status === "delivered"
        ? "delivered"
        : result.status === "uncertain"
          ? "uncertain"
          : "blocked";
    },
  });
  return {
    provider,
    transport,
    run: (scope: ResponseScope) =>
      scope.worldId === worldId
        ? run(scope)
        : Promise.resolve("offline_only" as const),
  };
}
