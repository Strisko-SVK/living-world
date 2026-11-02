import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test/no-network.ts"],
    include: ["src/**/*.test.ts"],
    exclude: ["src/db/**/*.db.test.ts"],
  },
});
