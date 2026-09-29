import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/db/**/*.db.test.ts"],
  },
});
