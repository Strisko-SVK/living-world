import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDatabaseClient } from "./client.js";
import {
  inspectMigration0019Preflight,
} from "../admin/dev-first-reply-migration-preflight.js";

const client = createDatabaseClient();
afterAll(async () => client.close());

describe("M2.15N migration 0019 read-only PostgreSQL 17 inspection", () => {
  it("recognizes reviewed 0019 applied only with exact DB guard and schema", async () => {
    // PostgreSQL 17 here is created as a disposable GitHub Actions service.
    // The owner DEV role/DB are never accepted by this CI override.
    const verdict = await inspectMigration0019Preflight(client.db, {
      database: "living_world_ci",
      role: "living_world_ci",
    });
    expect(verdict).toEqual({
      event: "npc_dev_first_reply_migration_preflight",
      migration: "0019_dev_first_reply_consents",
      status: "already_applied",
      reason: "already_applied_verified",
      readOnly: true,
      canMigrate: false,
      canSend: false,
    });
  });

  it("PostgreSQL prevents any DDL after SET TRANSACTION READ ONLY", async () => {
    await expect(
      client.db.transaction(async (tx) => {
        await tx.execute(sql.raw("set transaction read only"));
        await tx.execute(sql.raw(
          "create temporary table migration_0019_forbidden_write (id uuid)",
        ));
      }),
    ).rejects.toThrow();
  });
});
