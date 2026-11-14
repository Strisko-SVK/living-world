import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import {
  expectedMigration0019When,
  expectedMigrationTimes,
  isReviewedMigrationPlan,
} from "./scene-policy-migration-preflight.js";
import { validateGatewayDevDatabaseEnv } from "./gateway-dev-db.js";

// M2.15N: PREVIEW ONLY. This file never imports drizzle migrator, a
// fixture writer, a Discord client, a send transport or an LLM provider.
const migration = "0019_dev_first_reply_consents" as const;
const expectedDatabase = "living_world_gateway_dev";
const expectedRole = "lw_gateway_dev";
const tableName = "npc_dev_first_reply_consents";
const expectedConstraints: ReadonlyArray<readonly [string, string]> = [
  ["npc_dev_first_reply_consents_pkey", "p"],
  ["dev_reply_one_event_per_world", "u"],
  ["dev_reply_one_consent_per_interaction", "u"],
  ["dev_reply_original_interaction_scope_fk", "f"],
  ["dev_reply_player_world_fk", "f"],
  ["dev_reply_operator_world_fk", "f"],
  ["dev_reply_fixed_text", "c"],
  ["dev_reply_snowflakes", "c"],
  ["dev_reply_time_window", "c"],
  ["dev_reply_terminal_shape", "c"],
];
const expectedColumns: ReadonlyArray<readonly [string, string, boolean]> = [
  ["id", "uuid", true],
  ["world_id", "uuid", true],
  ["npc_id", "uuid", true],
  ["context_id", "uuid", true],
  ["interaction_id", "uuid", true],
  ["player_entity_id", "uuid", true],
  ["source_message_id", "text", true],
  ["source_guild_id", "text", true],
  ["source_parent_id", "text", true],
  ["source_thread_id", "text", true],
  ["operator_entity_id", "uuid", true],
  ["issued_by", "text", true],
  ["fixed_reply", "text", true],
  ["status", "text", true],
  ["issued_at", "timestamp with time zone", true],
  ["expires_at", "timestamp with time zone", true],
  ["attempt_id", "uuid", false],
  ["claimed_at", "timestamp with time zone", false],
  ["revoked_at", "timestamp with time zone", false],
  ["revoked_by", "text", false],
];

export type Migration0019Reason =
  | "pending_exactly_0019"
  | "already_applied_verified"
  | "unsafe_environment"
  | "local_migration_plan_drift"
  | "database_identity_mismatch"
  | "migration_history_missing"
  | "migration_history_drift"
  | "baseline_0018_invalid"
  | "schema_partial"
  | "read_failed";

export type Migration0019Preview = {
  event: "npc_dev_first_reply_migration_preflight";
  migration: typeof migration;
  status: "ready_for_backup" | "already_applied" | "blocked";
  reason: Migration0019Reason;
  readOnly: true;
  canMigrate: false;
  canSend: false;
};

export type Migration0019Facts = {
  identityValid: boolean;
  migrationTablePresent: boolean;
  appliedTimes: readonly string[];
  baseline0018Intact: boolean;
  consentTablePresent: boolean;
  guardFunctionPresent: boolean;
  guardFunctionIntact: boolean;
  immutableTriggerIntact: boolean;
  truncateTriggerIntact: boolean;
  constraintsIntact: boolean;
  columnsIntact: boolean;
  indexIntact: boolean;
  rlsDisabled: boolean;
};

function result(
  status: Migration0019Preview["status"],
  reason: Migration0019Reason,
): Migration0019Preview {
  return {
    event: "npc_dev_first_reply_migration_preflight",
    migration,
    status,
    reason,
    readOnly: true,
    canMigrate: false,
    canSend: false,
  };
}

// An advisory "ready_for_backup" explicitly does NOT mean canMigrate.
// Only an exact reviewed prefix and ABSENCE of all 0019 schema objects
// may be safely classified as pending; any partial application is blocked.
export function classifyMigration0019Preflight(
  facts: Migration0019Facts,
): Migration0019Preview {
  if (!facts.identityValid)
    return result("blocked", "database_identity_mismatch");
  if (!facts.migrationTablePresent)
    return result("blocked", "migration_history_missing");
  const applied = facts.appliedTimes;
  if (applied.length !== 19 && applied.length !== 20)
    return result("blocked", "migration_history_drift");
  const expected = [...expectedMigrationTimes, expectedMigration0019When];
  if (applied.some((value, i) => value !== String(expected[i])))
    return result("blocked", "migration_history_drift");
  if (!facts.baseline0018Intact)
    return result("blocked", "baseline_0018_invalid");

  const objects = [
    facts.consentTablePresent,
    facts.guardFunctionPresent,
    facts.immutableTriggerIntact,
    facts.truncateTriggerIntact,
    facts.constraintsIntact,
    facts.columnsIntact,
    facts.indexIntact,
    facts.rlsDisabled,
  ];
  if (applied.length === 19) {
    // rlsDisabled and the structural booleans are meaningful only when
    // the new table exists. "schema partial" catches a stray guard too.
    if (facts.consentTablePresent || facts.guardFunctionPresent ||
        facts.immutableTriggerIntact || facts.truncateTriggerIntact ||
        facts.constraintsIntact || facts.columnsIntact || facts.indexIntact ||
        facts.guardFunctionIntact)
      return result("blocked", "schema_partial");
    return result("ready_for_backup", "pending_exactly_0019");
  }

  if (objects.some((value) => value !== true) ||
      !facts.guardFunctionIntact)
    return result("blocked", "schema_partial");
  return result("already_applied", "already_applied_verified");
}

async function reviewedLocalMigration(): Promise<string | null> {
  try {
    const [journalBytes, sql0018, sql0019] = await Promise.all([
      readFile(new URL("../db/migrations/meta/_journal.json", import.meta.url)),
      readFile(new URL("../db/migrations/0018_scene_speech_policies.sql", import.meta.url)),
      readFile(new URL("../db/migrations/0019_dev_first_reply_consents.sql", import.meta.url)),
    ]);
    if (!isReviewedMigrationPlan(JSON.parse(journalBytes.toString("utf8")), sql0018, sql0019))
      return null;
    // Exact source is compared with pg_proc.prosrc, not only trigger names.
    // The SQL bytes are already pinned by M2.15M's reviewed Git blob.
    const sqlText = sql0019.toString("utf8");
    const match = sqlText.match(/CREATE FUNCTION public\.guard_dev_first_reply_consent\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/u);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function matchConstraints(
  rows: readonly Record<string, unknown>[],
): boolean {
  if (rows.length !== expectedConstraints.length) return false;
  const expected = new Map(expectedConstraints);
  for (const row of rows) {
    if (typeof row.conname !== "string" ||
        typeof row.contype !== "string" ||
        typeof row.definition !== "string" ||
        expected.get(row.conname) !== row.contype)
      return false;
    const def = row.definition;
    if (row.conname === "dev_reply_one_event_per_world" &&
        !def.includes("UNIQUE (world_id, source_message_id)")) return false;
    if (row.conname === "dev_reply_one_consent_per_interaction" &&
        !def.includes("UNIQUE (world_id, interaction_id)")) return false;
    if (row.conname === "dev_reply_fixed_text" &&
        !def.includes("Acknowledged. Standing by.")) return false;
    if (row.conname === "dev_reply_time_window" &&
        !def.includes("5 minutes")) return false;
    if (row.conname === "dev_reply_terminal_shape" &&
        (!def.includes("claimed") || !def.includes("revoked"))) return false;
    if (row.conname === "dev_reply_snowflakes" &&
        !def.includes("17,20")) return false;
    if (row.contype === "f" &&
        (!def.includes("FOREIGN KEY") || !def.includes("ON DELETE RESTRICT")))
      return false;
  }
  return true;
}

function matchColumns(rows: readonly Record<string, unknown>[]): boolean {
  return rows.length === expectedColumns.length &&
    expectedColumns.every(([name, type, notNull], i) =>
      rows[i]?.column_name === name &&
      rows[i]?.data_type === type &&
      rows[i]?.required === notNull
    );
}

type Database = DatabaseClient["db"];
export type Migration0019TestIdentity = {
  database: "living_world_ci";
  role: "living_world_ci";
};

// CI override works ONLY inside Vitest; it still validates the authenticated
// disposable CI role, never accepting an arbitrary database identity.
export async function inspectMigration0019Preflight(
  database: Database,
  ciIdentity?: Migration0019TestIdentity,
): Promise<Migration0019Preview> {
  if (ciIdentity && (process.env.NODE_ENV !== "test" ||
      ciIdentity.database !== "living_world_ci" ||
      ciIdentity.role !== "living_world_ci"))
    return result("blocked", "unsafe_environment");
  const expectedGuard = await reviewedLocalMigration();
  if (!expectedGuard) return result("blocked", "local_migration_plan_drift");
  const expectedDb = ciIdentity?.database ?? expectedDatabase;
  const expectedUser = ciIdentity?.role ?? expectedRole;
  try {
    return await database.transaction(async (tx) => {
      // First SQL in this transaction; PostgreSQL itself rejects writes.
      await tx.execute(sql.raw("set transaction read only"));
      await tx.execute(sql.raw("set local statement_timeout = '8s'"));
      const identity = await tx.execute(sql.raw(
        "select current_database() as database, current_user as db_role, " +
        "current_setting('server_version_num')::int as version, " +
        "(select pg_get_userbyid(datdba) from pg_database where datname=current_database()) as db_owner, " +
        "(select rolsuper from pg_roles where rolname=current_user) as superuser, " +
        "(select rolcreatedb from pg_roles where rolname=current_user) as createdb, " +
        "(select rolcreaterole from pg_roles where rolname=current_user) as createrole",
      ));
      const id = identity.rows[0];
      const identityValid =
        !!id && id.database === expectedDb &&
        id.db_role === expectedUser && id.db_owner === expectedUser &&
        typeof id.version === "number" &&
        id.version >= 170000 && id.version < 180000 &&
        (ciIdentity
          ? id.superuser === true && id.createdb === true && id.createrole === true
          : id.superuser === false && id.createdb === false && id.createrole === false);
      if (!identityValid)
        return result("blocked", "database_identity_mismatch");

      // Catalog-only checks; no private Discord content is read or output.
      const metadata = await tx.execute(sql.raw(
        "select " +
        "to_regclass('drizzle.__drizzle_migrations') is not null as migration_table, " +
        "to_regclass('public.npc_dev_first_reply_consents') is not null as consent_table, " +
        "to_regprocedure('public.guard_dev_first_reply_consent()') is not null as guard_function, " +
        "to_regclass('public.npc_scene_speech_policies') is not null as policy_table, " +
        "exists (select 1 from pg_trigger t where t.tgrelid=to_regclass('public.discord_context_mappings') " +
        "and t.tgname='discord_route_revision' and t.tgenabled='O' and not t.tgisinternal) as route_guard, " +
        "exists (select 1 from pg_trigger t where t.tgrelid=to_regclass('public.npc_scene_speech_policies') " +
        "and t.tgname='scene_speech_policy_immutable' and t.tgenabled='O' and not t.tgisinternal) as policy_guard, " +
        "exists (select 1 from pg_trigger t where t.tgrelid=to_regclass('public.npc_scene_speech_policies') " +
        "and t.tgname='scene_speech_policy_no_truncate' and t.tgenabled='O' and not t.tgisinternal) as policy_truncate, " +
        "(select count(*)=11 from pg_constraint pc " +
        "where pc.conrelid=to_regclass('public.npc_scene_speech_policies') " +
        "and pc.conname in ('npc_scene_speech_policies_pkey', 'scene_speech_presence_scope_fk', " +
        "'scene_speech_issuer_world_fk','scene_speech_role_host_only','scene_speech_decision_values'," +
        "'scene_speech_activity_values','scene_speech_perception_values','scene_speech_occupancy_values'," +
        "'scene_speech_positive_revision','scene_speech_bounded_window','scene_speech_revocation_shape')) " +
        "and to_regclass('public.scene_speech_one_open_policy') is not null " +
        "and to_regclass('public.scene_speech_world_presence_idx') is not null as policy_objects, " +
        "(select not relrowsecurity from pg_class where oid=to_regclass('public.npc_dev_first_reply_consents')) as rls_disabled, " +
        "to_regclass('public.dev_reply_world_status_idx') is not null as consent_index",
      ));
      const m = metadata.rows[0];
      if (!m?.migration_table)
        return result("blocked", "migration_history_missing");

      const migrations = await tx.execute(sql.raw(
        "select created_at::text as applied_at " +
        "from drizzle.__drizzle_migrations order by id",
      ));
      const history = migrations.rows.map((x) =>
        typeof x.applied_at === "string" ? x.applied_at : "",
      );

      // Skip reading consent metadata only if its relation does not exist.
      const exists = m.consent_table === true;
      const [columns, constraints, triggers, functions, indexes] =
        await Promise.all([
          tx.execute(sql.raw(
            "select attname as column_name, format_type(atttypid,atttypmod) as data_type, " +
            "attnotnull as required from pg_attribute " +
            "where attrelid=to_regclass('public.npc_dev_first_reply_consents') " +
            "and attnum>0 and not attisdropped order by attnum",
          )),
          tx.execute(sql.raw(
            "select conname, contype, pg_get_constraintdef(oid) as definition " +
            "from pg_constraint where conrelid=to_regclass('public.npc_dev_first_reply_consents') order by conname",
          )),
          tx.execute(sql.raw(
            "select tgname, tgenabled, tgtype::int as flags, tgisinternal, " +
            "tgfoid=to_regprocedure('public.guard_dev_first_reply_consent()') as correct_function " +
            "from pg_trigger where tgrelid=to_regclass('public.npc_dev_first_reply_consents') " +
            "and not tgisinternal order by tgname",
          )),
          tx.execute(sql.raw(
            "select p.prosrc as source, l.lanname as language, p.prosecdef as security_definer " +
            "from pg_proc p join pg_namespace n on n.oid=p.pronamespace " +
            "join pg_language l on l.oid=p.prolang " +
            "where n.nspname='public' and p.proname='guard_dev_first_reply_consent' and p.pronargs=0",
          )),
          tx.execute(sql.raw(
            "select pg_get_indexdef(to_regclass('public.dev_reply_world_status_idx')) as index_definition",
          )),
        ]);

      const triggerRows = triggers.rows;
      const byName = (name: string, flags: number): boolean =>
        triggerRows.length === 2 &&
        triggerRows.some((x) =>
          x.tgname === name && x.tgenabled === "O" &&
          x.flags === flags && x.tgisinternal === false &&
          x.correct_function === true
        );
      const functionRow = functions.rows[0];
      const functionPresent = functions.rows.length === 1;
      const indexDefinition = indexes.rows[0]?.index_definition;
      return classifyMigration0019Preflight({
        identityValid,
        migrationTablePresent: true,
        appliedTimes: history,
        baseline0018Intact:
          m.policy_table === true && m.route_guard === true &&
          m.policy_guard === true && m.policy_truncate === true &&
          m.policy_objects === true,
        consentTablePresent: exists,
        guardFunctionPresent: m.guard_function === true && functionPresent,
        guardFunctionIntact: functionPresent &&
          functionRow?.source === expectedGuard &&
          functionRow.language === "plpgsql" &&
          functionRow.security_definer === false,
        immutableTriggerIntact: byName("dev_first_reply_consent_immutable", 31),
        truncateTriggerIntact: byName("dev_first_reply_consent_no_truncate", 34),
        constraintsIntact: matchConstraints(constraints.rows),
        columnsIntact: matchColumns(columns.rows),
        indexIntact: typeof indexDefinition === "string" &&
          indexDefinition.includes("USING btree (world_id, status)"),
        rlsDisabled: m.rls_disabled === true,
      });
    });
  } catch {
    return result("blocked", "read_failed");
  }
}

export function parseMigration0019Arguments(args: readonly string[]): void {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return;
  throw Error("Migration 0019 preflight only accepts --preview.");
}

export async function runMigration0019Preflight(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
): Promise<Migration0019Preview> {
  try {
    parseMigration0019Arguments(args);
    validateGatewayDevDatabaseEnv(environment);
  } catch {
    return result("blocked", "unsafe_environment");
  }
  if (!(await reviewedLocalMigration()))
    return result("blocked", "local_migration_plan_drift");

  let client: ReturnType<typeof createDatabaseClient> | undefined;
  try {
    client = connect(environment);
    return await inspectMigration0019Preflight(client.db);
  } catch {
    return result("blocked", "read_failed");
  } finally {
    if (client) await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runMigration0019Preflight(process.argv.slice(2)).then(
    (v) => console.info(JSON.stringify(v)),
    () => {
      console.error(JSON.stringify(result("blocked", "read_failed")));
      process.exitCode = 1;
    },
  );
}
