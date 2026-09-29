import { describe, expect, it } from "vitest";

import { getDatabaseConfig } from "./config.js";

describe("getDatabaseConfig", () => {
  it("returns a valid PostgreSQL connection URL", () => {
    const config = getDatabaseConfig({
      DATABASE_URL: "postgresql://user:password@localhost:5432/living_world",
    });

    expect(config.databaseUrl).toBe(
      "postgresql://user:password@localhost:5432/living_world",
    );
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => getDatabaseConfig({})).toThrow("DATABASE_URL is required");
  });

  it("rejects a malformed DATABASE_URL", () => {
    expect(() => getDatabaseConfig({ DATABASE_URL: "not-a-url" })).toThrow(
      "DATABASE_URL must be a valid PostgreSQL URL",
    );
  });
});
