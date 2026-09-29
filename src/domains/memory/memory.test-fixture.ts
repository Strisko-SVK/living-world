import type { CreateMemoryInput } from "./memory.validation.js";

export const peloMemoryFixtures: readonly CreateMemoryInput[] = [
  {
    memoryType: "achievement",
    summary: "Severian Drahl noticed Pel`o's analysis and recruited him.",
    importance: 88,
    detailLevel: "high",
    retentionClass: "important",
    emotionalTags: ["pride", "gratitude"],
  },
  {
    memoryType: "episodic",
    summary: "Pel`o filed a requisition under the wrong administrative code.",
    importance: 28,
    detailLevel: "medium",
    retentionClass: "normal",
    emotionalTags: ["embarrassment"],
  },
];
