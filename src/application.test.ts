import { describe, expect, it } from "vitest";

import { applicationName } from "./application.js";

describe("applicationName", () => {
  it("identifies the application", () => {
    expect(applicationName).toBe("Living World");
  });
});
