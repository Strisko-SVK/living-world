import { describe, expect, it } from "vitest";

import {
  addEntityAliasInputSchema,
  createEntityInputSchema,
} from "./entity.validation.js";

describe("createEntityInputSchema", () => {
  it("accepts a supported entity type", () => {
    const result = createEntityInputSchema.safeParse({
      entityType: "npc",
      canonicalName: "Seneschal Garak",
    });

    expect(result.success).toBe(true);
  });

  it("rejects an unsupported entity type", () => {
    const result = createEntityInputSchema.safeParse({
      entityType: "planet",
      canonicalName: "Scintilla",
    });

    expect(result.success).toBe(false);
  });
});

describe("addEntityAliasInputSchema", () => {
  it("rejects a whitespace-only alias before normalization", () => {
    const result = addEntityAliasInputSchema.safeParse({ alias: "   " });

    expect(result.success).toBe(false);
  });
});
