import { describe, expect, it } from "vitest";
import {
  composeM219Context,
  projectConversationalPersona,
  selectM219History,
} from "./dialogue-context.js";

describe("M2.19 dialogue context", () => {
  it("selects older exchanges by player topic, not NPC repetition", () => {
    const pairs = [
      { player: "Hello", speech: "Hello" },
      { player: "Good morning", speech: "Good morning" },
      { player: "Weather", speech: "Forks forks forks" },
      { player: "Forks for dinner", speech: "Ask the kitchen" },
    ];
    const selected = selectM219History(pairs, "Find forks for dinner");
    expect(selected.recent).toEqual([pairs[1], pairs[0]]);
    expect(selected.excerpts).toEqual([pairs[3]]);
  });

  it("preserves three recent exchanges for short follow-ups", () => {
    const pairs = Array.from({ length: 5 }, (_, index) => ({
      player: "Question " + index,
      speech: "Reply " + index,
    }));
    expect(selectM219History(pairs, "And those?").recent).toEqual(
      pairs.slice(0, 3).reverse(),
    );
  });

  it("omits unprojected profile fields and keeps the current request last", () => {
    const persona = {
      name: "Marcus",
      identity: { role: "Quartermaster", species: "Human" },
      personality: { traits: ["Dry humor"], values: ["Fairness"] },
      privateNotes: "not projected",
    };
    expect(projectConversationalPersona(persona)).not.toHaveProperty(
      "privateNotes",
    );
    const context = composeM219Context({
      persona,
      permittedKnowledge: [
        { statement: "Wet crates" },
        { statement: "Forks for dinner" },
      ],
      currentSceneAndInteraction: { requestText: "Find forks for dinner" },
    });
    expect(context).toContain("Forks for dinner");
    expect(context).not.toContain("Wet crates");
    expect(context).not.toContain("not projected");
    expect(context.endsWith('Current player request: "Find forks for dinner"')).toBe(
      true,
    );
  });
});
