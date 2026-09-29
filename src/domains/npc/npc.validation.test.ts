import { describe, expect, it } from "vitest";

import {
  createNpcInputSchema,
  npcCapabilityInputSchema,
  npcGameProfileInputSchema,
} from "./npc.validation.js";

const baselineProfile = {
  identity: {
    name: "Peniel Suborbulo Amiam",
    species: "Human",
    role: "Administratum analyst",
  },
  summary: "A careful analyst with limited combat aptitude.",
  personality: {
    traits: ["methodical"],
  },
};

describe("createNpcInputSchema", () => {
  it("accepts bounded NPC creation input", () => {
    const result = createNpcInputSchema.safeParse({
      canonicalName: "Peniel Suborbulo Amiam",
      simulationDepth: 3,
      narrativeWeight: 22,
      baselineProfile,
    });

    expect(result.success).toBe(true);
  });

  it("rejects simulation depth outside its allowed range", () => {
    const result = createNpcInputSchema.safeParse({
      canonicalName: "Peniel Suborbulo Amiam",
      simulationDepth: 4,
      narrativeWeight: 22,
      baselineProfile,
    });

    expect(result.success).toBe(false);
  });

  it("rejects narrative weight outside its allowed range", () => {
    const result = createNpcInputSchema.safeParse({
      canonicalName: "Peniel Suborbulo Amiam",
      simulationDepth: 3,
      narrativeWeight: 101,
      baselineProfile,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unsupported lifecycle state", () => {
    const result = createNpcInputSchema.safeParse({
      canonicalName: "Peniel Suborbulo Amiam",
      simulationDepth: 3,
      narrativeWeight: 22,
      lifecycleState: "retired",
      baselineProfile,
    });

    expect(result.success).toBe(false);
  });
});

describe("npcGameProfileInputSchema", () => {
  it("rejects stat depth outside its allowed range", () => {
    const result = npcGameProfileInputSchema.safeParse({
      gameSystem: "mixed_dh_rt",
      statDepth: 4,
    });

    expect(result.success).toBe(false);
  });
});

describe("npcCapabilityInputSchema", () => {
  it("rejects an unsupported capability level", () => {
    const result = npcCapabilityInputSchema.safeParse({
      capabilityKey: "bureaucracy",
      level: "legendary",
      source: "profile",
      confidence: 0.8,
    });

    expect(result.success).toBe(false);
  });

  it("rejects confidence outside the zero-to-one range", () => {
    const result = npcCapabilityInputSchema.safeParse({
      capabilityKey: "bureaucracy",
      level: "expert",
      source: "profile",
      confidence: 1.1,
    });

    expect(result.success).toBe(false);
  });
});
