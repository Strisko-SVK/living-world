import { expect, it, vi } from "vitest";

const start = vi.hoisted(() => vi.fn());
vi.mock("./runtime.js", () => ({ startApplication: start }));

it("does not start the application when importing the entry module", async () => {
  await import("./index.js");
  expect(start).not.toHaveBeenCalled();
});
