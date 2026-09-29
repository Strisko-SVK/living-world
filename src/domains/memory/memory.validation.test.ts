import { describe, expect, it } from "vitest";

import {
  addMemoryRelationInputSchema,
  addMemorySourceInputSchema,
  createMemoryInputSchema,
  updateMemoryStatusInputSchema,
} from "./memory.validation.js";

const validMemory = {
  memoryType: "episodic",
  summary: "A valid memory.",
  importance: 50,
  detailLevel: "medium",
  retentionClass: "normal",
};

describe("memory validation", () => {
  it("accepts valid memory input", () => {
    expect(createMemoryInputSchema.parse(validMemory)).toMatchObject(
      validMemory,
    );
  });

  it.each([
    ["empty summary", { ...validMemory, summary: "  " }],
    ["importance below zero", { ...validMemory, importance: -1 }],
    ["importance above 100", { ...validMemory, importance: 101 }],
    ["invalid memory type", { ...validMemory, memoryType: "knowledge" }],
    ["invalid detail level", { ...validMemory, detailLevel: "full" }],
    ["invalid retention class", { ...validMemory, retentionClass: "forever" }],
  ])("rejects %s", (_, value) => {
    expect(() => createMemoryInputSchema.parse(value)).toThrow();
  });

  it("rejects an invalid status", () => {
    expect(() =>
      updateMemoryStatusInputSchema.parse({ status: "forgotten" }),
    ).toThrow();
  });

  it("rejects an invalid source type", () => {
    expect(() =>
      addMemorySourceInputSchema.parse({ sourceType: "llm" }),
    ).toThrow();
  });

  it("rejects an invalid supplied UUID", () => {
    expect(() =>
      addMemorySourceInputSchema.parse({
        sourceType: "official",
        sourceEntityId: "not-a-uuid",
      }),
    ).toThrow();
  });

  it("rejects an invalid relation type", () => {
    expect(() =>
      addMemoryRelationInputSchema.parse({
        parentMemoryId: "11111111-1111-4111-8111-111111111111",
        childMemoryId: "22222222-2222-4222-8222-222222222222",
        relationType: "causes",
      }),
    ).toThrow();
  });

  it("rejects a self-relation", () => {
    expect(() =>
      addMemoryRelationInputSchema.parse({
        parentMemoryId: "11111111-1111-4111-8111-111111111111",
        childMemoryId: "11111111-1111-4111-8111-111111111111",
        relationType: "related_to",
      }),
    ).toThrow();
  });
});
