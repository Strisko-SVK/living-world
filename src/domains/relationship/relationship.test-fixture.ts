import type { CreateRelationshipInput } from "./relationship.validation.js";

export const peloToSeverianRelationshipFixture: CreateRelationshipInput = {
  familiarity: 78,
  trust: 82,
  respect: 90,
  affection: 70,
  fear: 45,
  resentment: 0,
  dependence: 62,
  obligation: 68,
  intent: "genuine",
};

export const peloSeverianTaskEventFixture = {
  eventType: "assistance" as const,
  delta: { trust: 3, respect: 2, obligation: 2 },
  reasonSummary:
    "Severian publicly trusted Pel`o with an important administrative task.",
};
