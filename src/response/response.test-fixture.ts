import { vi } from "vitest";
import { createContextBuilder } from "../context/context-builder.js";
import {
  readerFixture,
  ids,
  interaction,
} from "../context/context.test-fixture.js";
import type { Interaction } from "../context/context.types.js";
import type { GenerationResult } from "../llm/contracts.js";
import { PROMPT_VERSION, type ResponseDependencies } from "./contracts.js";

export const responseSuccess = (
  text = JSON.stringify({
    speech: "I will consider the manifest, but I cannot confirm its accuracy.",
  }),
): GenerationResult => ({
  ok: true,
  text,
  observation: {
    traceId: ids.interaction,
    provider: "openai",
    model: "synthetic",
    outcome: "success",
    retries: 0,
    latencyMs: 1,
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    costMicros: "1",
    currency: "USD",
    costKind: "estimated_from_usage",
  },
});
export async function responseFixture() {
  const reader = readerFixture();
  let current: Interaction = interaction({ communicationMode: "local" });
  const npc = (await reader.npc(ids.world, ids.npc))!;
  vi.mocked(reader.npc).mockResolvedValue({
    ...npc,
    state: {
      ...npc.state!,
      currentLocationId: ids.otherScene,
      locationCertainty: "certain",
    },
  });
  const scene = (await reader.context(ids.world, ids.scene))!;
  vi.mocked(reader.context).mockResolvedValue({
    ...scene,
    linkedLocationEntityId: ids.otherScene,
  });
  vi.mocked(reader.interaction).mockImplementation(async () => current);
  const deps: ResponseDependencies = {
    read: vi.fn(async () => current),
    build: vi.fn(createContextBuilder(reader)),
    generate: vi.fn(async () => responseSuccess()),
    store: {
      claim: vi.fn(async () => {
        if (current.status !== "received" || current.responseClaimId)
          return null;
        current = {
          ...current,
          status: "processing",
          responseClaimId: ids.scene,
          responseClaimedAt: new Date("2026-01-02T00:00:00Z"),
          responsePromptVersion: PROMPT_VERSION,
          responseGenerationOutcome: "claimed",
        };
        return current;
      }),
      dispatch: vi.fn(async () => {
        current = {
          ...current,
          responseGenerationOutcome: "dispatched",
          responseDispatchedAt: new Date("2026-01-02T00:00:01Z"),
        };
        return true;
      }),
      persist: vi.fn(async (_s, _id, text) => {
        current = {
          ...current,
          responseText: text,
          status: "responded",
          responseGenerationOutcome: "responded",
          respondedAt: new Date("2026-01-02T00:00:02Z"),
        };
        return current;
      }),
      fail: vi.fn(async (_s, _id, uncertain) => {
        if (current.status === "processing")
          current = {
            ...current,
            status: "failed",
            responseGenerationOutcome: uncertain ? "uncertain" : "failed",
          };
      }),
      reconcile: vi.fn(async () => "active" as const),
    },
  };
  return {
    deps,
    reader,
    get current() {
      return current;
    },
    setCurrent: (overrides: Partial<Interaction>) => {
      current = { ...current, ...overrides };
    },
  };
}
