import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDatabaseClient } from "./client.js";
import { inspectMigration0019Preflight } from "../admin/dev-first-reply-migration-preflight.js";

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
    if (verdict.status !== "already_applied") {
      // Temporary CI-only metadata diagnostics; no user messages are read.
      const [constraints, triggers, columns, indexes, guards] =
        await Promise.all([
          client.db.execute(sql.raw(
            "select conname, contype, pg_get_constraintdef(oid) as definition " +
              "from pg_constraint where conrelid=to_regclass('public.npc_dev_first_reply_consents')",
          )),
          client.db.execute(sql.raw(
            "select tgname, tgenabled, tgtype::int as flags, " +
              "tgfoid=to_regprocedure('public.guard_dev_first_reply_consent()') as correct_function " +
              "from pg_trigger where tgrelid=to_regclass('public.npc_dev_first_reply_consents') and not tgisinternal",
          )),
          client.db.execute(sql.raw(
            "select attname as name, format_type(atttypid,atttypmod) as type, attnotnull as required " +
              "from pg_attribute where attrelid=to_regclass('public.npc_dev_first_reply_consents') " +
              "and attnum>0 and not attisdropped order by attnum",
          )),
          client.db.execute(sql.raw(
            "select pg_get_indexdef(to_regclass('public.dev_reply_world_status_idx')) as definition",
          )),
          client.db.execute(sql.raw(
            "select p.prosrc as source, l.lanname as lang, p.prosecdef as security_definer " +
              "from pg_proc p join pg_namespace n on n.oid=p.pronamespace " +
              "join pg_language l on l.oid=p.prolang " +
              "where n.nspname='public' and p.proname='guard_dev_first_reply_consent' and p.pronargs=0",
          )),
        ]);
      const sqlFile = await import("node:fs/promises");
      const raw = await sqlFile.readFile(
        new URL("./migrations/0019_dev_first_reply_consents.sql", import.meta.url),
        "utf8",
      );
      const expectedBody = raw.match(
        /CREATE FUNCTION public\.guard_dev_first_reply_consent\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/u,
      )?.[1];
      console.info("M215N_CATALOG_DIAGNOSTIC", JSON.stringify({
        verdict,
        constraints: constraints.rows,
        triggers: triggers.rows,
        columns: columns.rows,
        indexes: indexes.rows,
        guardCount: guards.rows.length,
        guardLanguage: guards.rows[0]?.lang,
        guardDefiner: guards.rows[0]?.security_definer,
        guardEqual: guards.rows[0]?.source === expectedBody,
        guardTrimEqual: typeof guards.rows[0]?.source === "string" &&
          guards.rows[0].source.trim() === expectedBody?.trim(),
        guardLengths: [String(guards.rows[0]?.source ?? "").length, expectedBody?.length],
      }));
    }
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
        await tx.execute(
          sql.raw(
            "create temporary table migration_0019_forbidden_write (id uuid)",
          ),
        );
      }),
    ).rejects.toThrow();
  });
});
