import type { CreateKnowledgeInput } from "./knowledge.validation.js";

export const peloKnowledgeFixtures: readonly CreateKnowledgeInput[] = [
  {
    claimText: "Official docking manifest lists ten cargo crates.",
    classification: "reported_claim",
    confidence: 0.9,
    secrecy: "restricted",
  },
  {
    claimText: "A dock worker claims fourteen crates were unloaded.",
    classification: "reported_claim",
    confidence: 0.55,
    secrecy: "public",
  },
];
