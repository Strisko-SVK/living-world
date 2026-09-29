import { describe, expect, it } from "vitest";

import {
  applyRelationshipEventInputSchema,
  createRelationshipInputSchema,
  relationshipDeltaSchema,
  relationshipEndpointsSchema,
} from "./relationship.validation.js";

const sourceEntityId = "11111111-1111-4111-8111-111111111111";

describe("relationship validation", () => {
  it("accepts valid relationship input", () => {
    expect(createRelationshipInputSchema.parse({ trust: 55 })).toMatchObject({
      trust: 55,
      familiarity: 0,
    });
  });

  it("rejects identical source and target entities", () => {
    expect(() =>
      relationshipEndpointsSchema.parse({
        sourceEntityId,
        targetEntityId: sourceEntityId,
      }),
    ).toThrow();
  });

  it.each([
    ["dimension below zero", { trust: -1 }],
    ["dimension above 100", { trust: 101 }],
    ["invalid intent", { intent: "hostile" }],
  ])("rejects %s", (_, value) => {
    expect(() => createRelationshipInputSchema.parse(value)).toThrow();
  });

  it("accepts a valid delta", () => {
    expect(relationshipDeltaSchema.parse({ trust: -10, fear: 5 })).toEqual({
      trust: -10,
      fear: 5,
    });
  });

  it.each([
    ["an empty delta", {}],
    ["an unknown delta key", { reputation: 5 }],
    ["a delta below the allowed range", { trust: -101 }],
    ["a delta above the allowed range", { trust: 101 }],
  ])("rejects %s", (_, value) => {
    expect(() => relationshipDeltaSchema.parse(value)).toThrow();
  });

  it("rejects an invalid event type", () => {
    expect(() =>
      applyRelationshipEventInputSchema.parse({
        eventType: "automatic",
        delta: { trust: 1 },
        reasonSummary: "A reason.",
      }),
    ).toThrow();
  });

  it("rejects an empty reason summary", () => {
    expect(() =>
      applyRelationshipEventInputSchema.parse({
        eventType: "assistance",
        delta: { trust: 1 },
        reasonSummary: "  ",
      }),
    ).toThrow();
  });
});
