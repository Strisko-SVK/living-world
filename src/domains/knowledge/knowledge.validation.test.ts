import { describe, expect, it } from "vitest";

import {
  addKnowledgeSourceInputSchema,
  createKnowledgeConflictInputSchema,
  createKnowledgeInputSchema,
  updateKnowledgeStatusInputSchema,
} from "./knowledge.validation.js";

const validKnowledge = {
  claimText: "A valid subjective claim.",
  classification: "reported_claim",
  confidence: 0.5,
  secrecy: "private",
};

describe("knowledge validation", () => {
  it("accepts valid knowledge input", () => {
    expect(createKnowledgeInputSchema.parse(validKnowledge)).toMatchObject(
      validKnowledge,
    );
  });

  it.each([
    ["empty claim", { ...validKnowledge, claimText: "  " }],
    ["confidence below zero", { ...validKnowledge, confidence: -0.01 }],
    ["confidence above one", { ...validKnowledge, confidence: 1.01 }],
    ["invalid classification", { ...validKnowledge, classification: "truth" }],
    ["invalid secrecy", { ...validKnowledge, secrecy: "classified" }],
    ["empty predicate", { ...validKnowledge, predicate: " " }],
  ])("rejects %s", (_, value) => {
    expect(() => createKnowledgeInputSchema.parse(value)).toThrow();
  });

  it("rejects an invalid status", () => {
    expect(() =>
      updateKnowledgeStatusInputSchema.parse({ status: "resolved" }),
    ).toThrow();
  });

  it("rejects an invalid source type", () => {
    expect(() =>
      addKnowledgeSourceInputSchema.parse({ sourceType: "llm" }),
    ).toThrow();
  });

  it("rejects a negative source chain depth", () => {
    expect(() =>
      addKnowledgeSourceInputSchema.parse({
        sourceType: "heard",
        chainDepth: -1,
      }),
    ).toThrow();
  });

  it("rejects identical conflict claim IDs", () => {
    expect(() =>
      createKnowledgeConflictInputSchema.parse({
        claimAId: "11111111-1111-4111-8111-111111111111",
        claimBId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow();
  });
});
