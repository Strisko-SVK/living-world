import { describe, expect, it, vi } from "vitest";
import type { GenerationResult } from "../llm/contracts.js";
import { dialogueCases } from "./m219-dialogue-cases.js";
import {
  buildDialogueBenchmarkPrompt,
  runDialogueBenchmark,
  variants,
} from "./m219-dialogue-benchmark.js";

const scenario = dialogueCases.find((entry) => entry.id === "RP-ABSURD-001")!;

describe("M2.19 dialogue benchmark", () => {
  it("holds intent constant while adding context and output constraints", () => {
    const prompts = variants.map((variant) =>
      buildDialogueBenchmarkPrompt(variant, scenario, "quartermaster"),
    );
    for (const prompt of prompts)
      expect(prompt.messages[0].content).toContain(scenario.request);
    expect(prompts[0].messages[0].content).toBe(scenario.request);
    expect(prompts[1].messages[0].content).toContain("Marcus Voss");
    expect(prompts[1].messages[0].content).not.toContain("permittedKnowledge");
    expect(prompts[2].messages[0].content).toContain("permittedKnowledge");
    expect(prompts[2].messages[0].content).not.toContain("Hoho");
    expect(prompts[3].messages[0].content).toContain("Hoho");
    expect(prompts[4].responseFormat?.name).toBe("npc_speech");
    expect(prompts[4].compactMessages?.[0].content).not.toContain("Hoho");
    expect(prompts[4].compactMessages?.[0].content).toContain(scenario.request);
  });

  it("does not share Quartermaster knowledge with comparison NPCs", () => {
    const prompt = buildDialogueBenchmarkPrompt("E", scenario, "barman");
    expect(prompt.messages[0].content).toContain("Nemeia Caldris");
    expect(prompt.messages[0].content).not.toContain("Six coolant canisters");
    const sentinel = buildDialogueBenchmarkPrompt("B", scenario, "sentinel");
    expect(sentinel.messages[0].content).toContain("Sentinel-001");
  });

  it("records repeated samples and rejects malformed structured speech", async () => {
    const records: Record<string, unknown>[] = [];
    const generate = vi.fn(async (): Promise<GenerationResult> => ({
      ok: true,
      text: "mock speech (not inference evidence)",
      observation: {
        traceId: "test",
        provider: "raon",
        model: "mock",
        outcome: "success",
        retries: 0,
        latencyMs: 1,
        usage: null,
        currency: null,
        costMicros: null,
        costKind: "none",
      },
    }));
    await runDialogueBenchmark(generate, {
      signal: new AbortController().signal,
      cases: [scenario],
      temperature: 0.1,
      write: (record) => records.push(record),
    });
    expect(generate).toHaveBeenCalledTimes(15);
    expect(records.filter((record) => record.variant === "E")).toHaveLength(3);
    expect(
      records
        .filter((record) => record.variant === "E")
        .every((record) => record.outcome === "invalid_speech"),
    ).toBe(true);
  });
});
