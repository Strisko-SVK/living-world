import { describe, expect, it } from "vitest";
import { composeResponsePrompt } from "./prompt.js";

describe("M2.19 adaptive NPC response policy", () => {
  const context = {
    sections: {
      persona: {
        name: "Nemeia",
        identity: { role: "Barman" },
        personality: { traits: ["Wry"] },
      },
      currentSceneAndInteraction: { requestText: "Tell me more." },
    },
  } as unknown as Parameters<typeof composeResponsePrompt>[0];

  it("preserves current intent, NPC voice and strict output boundaries", () => {
    const prompt = composeResponsePrompt(context, 2000, "natural-v2");
    expect(prompt.messages[0].content).toContain("Tell me more.");
    expect(prompt.instructions.system).toContain("in-character");
    expect(prompt.instructions.system).toContain("concise");
    expect(prompt.instructions.system).toContain("expand");
    expect(prompt.instructions.system).not.toContain("one to three");
    expect(prompt.instructions.developer).toContain("only the key");
    expect(prompt.responseFormat.schema).toMatchObject({
      required: ["speech"],
      additionalProperties: false,
    });
  });

  it("does not force short replies in the non-experimental natural profile", () => {
    const prompt = composeResponsePrompt(context, 2000, "natural");
    expect(prompt.instructions.system).toContain("longer");
    expect(prompt.instructions.system).not.toContain("one to three");
  });
});
