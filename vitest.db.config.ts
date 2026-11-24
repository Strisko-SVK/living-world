import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several integrity fixtures temporarily change constraints on the shared DB.
    fileParallelism: false,
    setupFiles: ["./src/test/no-network.ts"],
    include: ["src/db/**/*.db.test.ts"],
  },
});
