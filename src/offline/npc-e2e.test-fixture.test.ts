import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import { createOfflineNpcTestHarness } from "./npc-e2e.test-fixture.js";

const worldId = "11111111-1111-4111-8111-111111111111";
function database(databaseName: string, key: string | null) {
  const query = vi.fn().mockResolvedValue({
    rows: [{ database_name: databaseName, world_key: key }],
  });
  return {
    instance: {
      pool: {
        query,
        options: {
          get connectionString() {
            return process.env.DATABASE_URL;
          },
        },
      },
    } as unknown as DatabaseClient,
    query,
  };
}
describe("M2.12 fake-only harness gates", () => {
  it("refuses remote PostgreSQL before access", async () => {
    const f = database("living_world_ci", "delivery-test-" + worldId);
    vi.stubEnv("DATABASE_URL", "postgresql://192.0.2.44/living_world_ci");
    try {
      await expect(
        createOfflineNpcTestHarness(f.instance, worldId),
      ).rejects.toThrow("unsafe database");
      expect(f.query).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    [
      "query host override",
      "postgresql://localhost/living_world_ci?host=192.0.2.44",
    ],
    [
      "query ssl override",
      "postgresql://localhost/living_world_ci?sslmode=require",
    ],
    ["unexpected protocol", "http://localhost/living_world_ci"],
  ])("refuses %s before accessing the DB", async (_case, url) => {
    const f = database("living_world_ci", "delivery-test-" + worldId);
    vi.stubEnv("DATABASE_URL", url);
    try {
      await expect(
        createOfflineNpcTestHarness(f.instance, worldId),
      ).rejects.toThrow("unsafe database");
      expect(f.query).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("refuses a pool whose real connection configuration differs from the validated URL", async () => {
    const f = database("living_world_ci", "delivery-test-" + worldId);
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/living_world_ci");
    Object.defineProperty(f.instance.pool, "options", {
      value: {
        connectionString: "postgresql://db.example.com/living_world_ci",
      },
    });
    try {
      await expect(
        createOfflineNpcTestHarness(f.instance, worldId),
      ).rejects.toThrow("does not match DATABASE_URL");
      expect(f.query).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    ["wrong database", "living_world_prod", "delivery-test-" + worldId],
    ["wrong world", "living_world_ci", "lw-dev-pilot-001"],
    ["missing world", "living_world_ci", null],
  ])("refuses %s on a local test URL", async (_label, dbName, key) => {
    const f = database(dbName, key);
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/living_world_ci");
    vi.stubEnv("DISCORD_ENABLED", "false");
    vi.stubEnv("LLM_PROVIDER", "disabled");
    try {
      await expect(
        createOfflineNpcTestHarness(f.instance, worldId),
      ).rejects.toThrow("disposable synthetic world");
      expect(f.query).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
