import { describe, expect, it } from "vitest";

import { normalizeAlias } from "./alias-normalizer.js";

describe("normalizeAlias", () => {
  it("trims, lowercases, and collapses repeated whitespace", () => {
    expect(normalizeAlias("  Seneschal   Garak ")).toBe("seneschal garak");
  });

  it("preserves meaningful punctuation", () => {
    expect(normalizeAlias("Captain O'Rourke")).toBe("captain o'rourke");
  });
});
