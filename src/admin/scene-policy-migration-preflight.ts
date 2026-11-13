import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../db/client.js";
import { validateGatewayDevDatabaseEnv } from "./gateway-dev-db.js";

// This file never imports the migrator. Running the preview cannot apply SQL.
const expectedDatabase = "living_world_gateway_dev";
const expectedRole = "lw_gateway_dev";
const migrationTag = "0018_scene_speech_policies";

// These are the published, reviewed Drizzle journal timestamps through 0018.
// Pinning the complete prefix prevents an unnoticed new migration, a missing
// earlier migration, or a different journal from being treated as safe.
export const expectedMigrationTimes = [
  1790249280186, 1790250202078, 1790668018203, 1790668371766,
  1790668977094, 1790758274435, 1790758523569, 1790758802257,
  1792431687825, 1792432355849, 1792434787205, 1792436374558,
  1793220272404, 1793533567330, 1793534423374, 1793535587173,
  1793647173083, 1793972100000, 1794611200000,
] as const;

// SHA-1 is the reviewed Git blob content ID of migration 0018 in merged
// M2.15E main. This protects against accidental local file/source drift,
// not against an attacker who already controls repository code.
const approvedMigrationBlob = "55dff82871c3ee3785c6c88b336b329ca88f3992";
const expectedMigrationTags = [
  "0000_freezing_dreaming_celestial",
  "0001_petite_gravity",
  "0002_strange_annihilus",
  "0003_free_surge",
  "0004_outstanding_sharon_carter",
  "0005_smooth_jigsaw",
  "0006_fresh_daredevil",
  "0007_famous_vector",
  "0008_mapping_integrity",
  "0009_discord_event_idempotency",
  "0010_llm_budget_accounting",
  "0011_npc_response_claims",
  "0012_context_intake_policy",
  "0013_local_presence",
  "0014_presence_lifecycle",
  "0015_response_delivery_outbox",
  "0016_discord_outbound_limits",
  "0017_discord_route_revision",
  "0018_scene_speech_policies",
] as const;

export function isReviewedMigrationPlan(
  rawJournal: unknown,
  rawSql: Uint8Array,
): boolean {
  if (
    !rawJournal ||
    typeof rawJournal !== "object" ||
    !("entries" in rawJournal) ||
    !("dialect" in rawJournal) ||
    !("version" in rawJournal)
  ) return false;
  const journal = rawJournal as Record<string, unknown>;
  if (
    journal.version !== "7" ||
    journal.dialect !== "postgresql" ||
    !Array.isArray(journal.entries) ||
    journal.entries.length !== expectedMigrationTimes.length
  ) return false;

  const entries = journal.entries;
  for (let i = 0; i < expectedMigrationTimes.length; i += 1) {
    const entry: unknown = entries[i];
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    if (
      e.idx !== i ||
      e.version !== "7" ||
      e.when !== expectedMigrationTimes[i] ||
      e.tag !== expectedMigrationTags[i] ||
      e.breakpoints !== true
    ) return false;
  }
  const hash = createHash("sha1")
    .update("blob " + rawSql.byteLength + String.fromCharCode(0))
    .update(rawSql)
    .digest("hex");
  return hash === approvedMigrationBlob;
}

async function localMigrationPlanReviewed(): Promise<boolean> {
  try {
    const [journalBytes, sqlBytes] = await Promise.all([
      readFile(new URL("../db/migrations/meta/_journal.json", import.meta.url)),
      readFile(new URL("../db/migrations/0018_scene_speech_policies.sql", import.meta.url)),
    ]);
    return isReviewedMigrationPlan(
      JSON.parse(journalBytes.toString("utf8")),
      sqlBytes,
    );
  } catch {
    return false;
  }
}

export type MigrationPreflightReason =
  | "pending_exactly_0018"
  | "already_applied_verified"
  | "database_identity_mismatch"
  | "migration_history_missing"
  | "migration_history_drift"
  | "local_migration_plan_drift"
  | "schema_partial"
  | "route_trigger_missing"
  | "unsafe_environment"
  | "read_failed";

export type MigrationPreflight = {
  event: "npc_scene_policy_migration_preflight";
  migration: typeof migrationTag;
  status: "ready_for_backup" | "already_applied" | "blocked";
  reason: MigrationPreflightReason;
  readOnly: true;
  canMigrate: false;
};

function report(
  status: MigrationPreflight["status"],
  reason: MigrationPreflightReason,
): MigrationPreflight {
  return {
    event: "npc_scene_policy_migration_preflight",
    migration: migrationTag,
    status,
    reason,
    readOnly: true,
    canMigrate: false,
  };
}

export type MigrationPreflightFacts = {
  identityValid: boolean;
  migrationTablePresent: boolean;
  appliedTimes: readonly string[];
  routeTriggerInstalled: boolean;
  policyTablePresent: boolean;
  policyUpdateTriggerInstalled: boolean;
  policyTruncateTriggerInstalled: boolean;
  policyObjectsIntact: boolean;
};

// Fail-closed, side-effect-free classification. The local CLI can print only
// this fixed vocabulary; it never prints a DB URL, SQL or stored NPC data.
export function classifyMigration0018Preflight(
  f: MigrationPreflightFacts,
): MigrationPreflight {
  if (!f.identityValid) return report("blocked", "database_identity_mismatch");
  if (!f.migrationTablePresent)
    return report("blocked", "migration_history_missing");
  const known = f.appliedTimes.length;
  if (known !== 18 && known !== 19)
    return report("blocked", "migration_history_drift");
  for (let i = 0; i < known; i += 1) {
    if (f.appliedTimes[i] !== String(expectedMigrationTimes[i]))
      return report("blocked", "migration_history_drift");
  }
  if (!f.routeTriggerInstalled)
    return report("blocked", "route_trigger_missing");
  if (known === 18) {
    if (
      f.policyTablePresent ||
      f.policyUpdateTriggerInstalled ||
      f.policyTruncateTriggerInstalled
    )
      return report("blocked", "schema_partial");
    return report("ready_for_backup", "pending_exactly_0018");
  }
  if (
    !f.policyTablePresent ||
    !f.policyUpdateTriggerInstalled ||
    !f.policyTruncateTriggerInstalled ||
    !f.policyObjectsIntact
  )
    return report("blocked", "schema_partial");
  return report("already_applied", "already_applied_verified");
}

type Database = DatabaseClient["db"];

// The first SQL command *inside* the transaction is SET TRANSACTION READ ONLY.
// No preview path calls a migrator, backup process, or writes fixture data.
export type PreflightTestIdentity = {
  database: "living_world_ci";
  role: "living_world_ci";
};

// A separate identity is accepted ONLY in Vitest to validate against the
// disposable CI PostgreSQL database. The owner CLI uses fixed DEV identity.
export async function inspectMigration0018Preflight(
  database: Database,
  ciIdentity?: PreflightTestIdentity,
): Promise<MigrationPreflight> {
  if (ciIdentity && process.env.NODE_ENV !== "test")
    return report("blocked", "unsafe_environment");
  const targetDatabase = ciIdentity?.database ?? expectedDatabase;
  const targetRole = ciIdentity?.role ?? expectedRole;
  try {
    return await database.transaction(async (tx) => {
      await tx.execute(sql.raw("set transaction read only"));
      await tx.execute(sql.raw("set local statement_timeout = '8s'"));
      const result = await tx.execute(sql.raw(
        "select current_database() as database, current_user as db_role, " +
          "current_setting('server_version_num')::int as version, " +
          "(select pg_get_userbyid(datdba) from pg_database " +
          " where datname=current_database()) as db_owner, " +
          "(select rolsuper from pg_roles where rolname=current_user) as superuser, " +
          "(select rolcreatedb from pg_roles where rolname=current_user) as createdb, " +
          "(select rolcreaterole from pg_roles where rolname=current_user) as createrole",
      ));
      const id = result.rows[0];
      const identityValid = !!id &&
        id.database === targetDatabase &&
        id.db_role === targetRole &&
        id.db_owner === targetRole &&
        typeof id.version === "number" &&
        id.version >= 170000 && id.version < 180000 &&
        (ciIdentity
          ? id.superuser === true && id.createdb === true &&
            id.createrole === true
          : id.superuser === false && id.createdb === false &&
            id.createrole === false);
      // Stop immediately if connected to an unexpected database, even if
      // the endpoint string passed a previous environment check.
      if (!identityValid)
        return report("blocked", "database_identity_mismatch");

      const schema = await tx.execute(sql.raw(
        "select " +
          "to_regclass('drizzle.__drizzle_migrations') is not null as migration_table, " +
          "to_regclass('public.npc_scene_speech_policies') is not null as policy_table, " +
          "exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid " +
          "join pg_namespace n on n.oid=c.relnamespace " +
          "where n.nspname='public' and c.relname='discord_context_mappings' " +
          "and t.tgname='discord_route_revision' and t.tgenabled='O' " +
          "and not t.tgisinternal) as route_trigger, " +
          "exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid " +
          "join pg_namespace n on n.oid=c.relnamespace " +
          "where n.nspname='public' and c.relname='npc_scene_speech_policies' " +
          "and t.tgname='scene_speech_policy_immutable' and t.tgenabled='O' " +
          "and not t.tgisinternal) as policy_update_trigger, " +
          "exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid " +
          "join pg_namespace n on n.oid=c.relnamespace " +
          "where n.nspname='public' and c.relname='npc_scene_speech_policies' " +
          "and t.tgname='scene_speech_policy_no_truncate' and t.tgenabled='O' " +
          "and not t.tgisinternal) as policy_truncate_trigger, " +
          "(select count(*)=11 from pg_constraint pc " +
          "where pc.conrelid=to_regclass('public.npc_scene_speech_policies') " +
          "and pc.conname in ('npc_scene_speech_policies_pkey', " +
          "'scene_speech_presence_scope_fk', 'scene_speech_issuer_world_fk', " +
          "'scene_speech_role_host_only', 'scene_speech_decision_values', " +
          "'scene_speech_activity_values', 'scene_speech_perception_values', " +
          "'scene_speech_occupancy_values', 'scene_speech_positive_revision', " +
          "'scene_speech_bounded_window', 'scene_speech_revocation_shape')) " +
          "and to_regclass('public.scene_speech_one_open_policy') is not null " +
          "and to_regclass('public.scene_speech_world_presence_idx') is not null " +
          "as policy_objects_intact",
      ));
      const row = schema.rows[0];
      if (!row?.migration_table)
        return report("blocked", "migration_history_missing");

      const migrations = await tx.execute(
        sql.raw(
          "select created_at::text as applied_at " +
            "from drizzle.__drizzle_migrations order by id",
        ),
      );
      return classifyMigration0018Preflight({
        identityValid,
        migrationTablePresent: row.migration_table === true,
        appliedTimes: migrations.rows.map((r) =>
          typeof r.applied_at === "string" ? r.applied_at : "",
        ),
        routeTriggerInstalled: row.route_trigger === true,
        policyTablePresent: row.policy_table === true,
        policyUpdateTriggerInstalled: row.policy_update_trigger === true,
        policyTruncateTriggerInstalled: row.policy_truncate_trigger === true,
        policyObjectsIntact: row.policy_objects_intact === true,
      });
    });
  } catch {
    return report("blocked", "read_failed");
  }
}

export function parseMigrationPreflightArguments(args: readonly string[]): void {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return;
  throw new Error("Migration 0018 preflight accepts only --preview.");
}

export async function runMigration0018Preflight(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
): Promise<MigrationPreflight> {
  parseMigrationPreflightArguments(args);
  try {
    validateGatewayDevDatabaseEnv(environment);
  } catch {
    return report("blocked", "unsafe_environment");
  }
  if (!(await localMigrationPlanReviewed()))
    return report("blocked", "local_migration_plan_drift");
  const client = connect(environment);
  try {
    return await inspectMigration0018Preflight(client.db);
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runMigration0018Preflight(process.argv.slice(2)).then(
    (preview) => console.info(JSON.stringify(preview)),
    () => {
      console.error(JSON.stringify({
        event: "npc_scene_policy_migration_preflight_failed_safely",
      }));
      process.exitCode = 1;
    },
  );
}
