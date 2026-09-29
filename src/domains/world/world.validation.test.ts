import { describe, expect, it } from "vitest";

import { createWorldInputSchema } from "./world.validation.js";

describe("createWorldInputSchema", () => {
  it("accepts a minimal valid world", () => {
    const result = createWorldInputSchema.safeParse({
      key: "calixis-sector",
      name: "Calixis Sector",
      systemType: "warhammer_40k",
    });

    expect(result.success).toBe(true);
  });

  it("rejects an invalid world status", () => {
    const result = createWorldInputSchema.safeParse({
      key: "calixis-sector",
      name: "Calixis Sector",
      systemType: "warhammer_40k",
      status: "deleted",
    });

    expect(result.success).toBe(false);
  });
});
