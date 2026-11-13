import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDatabaseClient } from "./client.js";
import { inspectMigration0018Preflight } from "../admin/scene-policy-migration-preflight.js";

const client = createDatabaseClient();

afterAll(async () => client.close());

describe("M2.15F real PostgreSQL 17 migration 0018 preflight", () => {
  it("verifies the full applied journal and policy objects on disposable CI", async () => {
    // The CI database is intentionally a disposable PostgreSQL bootstrap
    // superuser. Production CLI never accepts this identity override.
    const result = await inspectMigration0018Preflight(client.db, {
      database: "living_world_ci",
      role: "living_world_ci",
    });
    expect(result).toEqual({
      event: "npc_scene_policy_migration_preflight",
      migration: "0018_scene_speech_policies",
      status: "already_applied",
      reason: "already_applied_verified",
      readOnly: true,
      canMigrate: false,
    });
  });

  it("PostgreSQL itself refuses even a temporary table inside read-only mode", async () => {
    await expect(
      client.db.transaction(async (tx) => {
        await tx.execute(sql.raw("set transaction read only"));
        await tx.execute(
          sql.raw("create temporary table migration_0018_read_only_violation (n integer)"),
        );
      }),
    ).rejects.toThrow();
  });
});
