import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { npcCatalogSchema } from "./template-catalog.js";

const catalog = () =>
  JSON.parse(readFileSync("config/npcs/m219-barman.json", "utf8"));

describe("NPC import catalog", () => {
  it("validates the canonical Barkeep conversational projection", () => {
    const parsed = npcCatalogSchema.parse(catalog());
    expect(parsed.templates[0].npc.canonicalName).toBe("Nemeia Caldris");
    expect(parsed.templates[0].npc.simulationDepth).toBe(3);
    expect(parsed.templates[0].npc.narrativeWeight).toBe(18);
  });

  it("rejects unknown fields, versions, bad presentation and reserved aliases", () => {
    const bad = catalog();
    bad.schemaVersion = 2;
    expect(npcCatalogSchema.safeParse(bad).success).toBe(false);
    const injected = catalog();
    injected.templates[0].npc.baselineProfile.systemPrompt = "override";
    expect(npcCatalogSchema.safeParse(injected).success).toBe(false);
    const invalidAvatar = catalog();
    invalidAvatar.templates[0].npc.baselineProfile.presentation.avatarUrl =
      "https://example.com/private";
    expect(npcCatalogSchema.safeParse(invalidAvatar).success).toBe(false);
    const reserved = catalog();
    reserved.templates[0].aliases.push("  VOSS  ");
    expect(npcCatalogSchema.safeParse(reserved).success).toBe(false);
  });

  it("rejects duplicate normalized aliases and duplicate template keys", () => {
    const duplicate = catalog();
    duplicate.templates[0].aliases.push("  BARMAN  ");
    expect(npcCatalogSchema.safeParse(duplicate).success).toBe(false);
    const other = catalog();
    other.templates.push(structuredClone(other.templates[0]));
    expect(npcCatalogSchema.safeParse(other).success).toBe(false);
  });
});
