import { randomBytes } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;
const DEV = "living_world_gateway_dev";
const DEV_ROLE = "lw_gateway_dev";
const CI = "living_world_ci";
const CI_ROLE = "lw_gateway_ci";
const PORT = "55432";
const path = ".env.gateway-ci.local";
const hex = /^[a-f0-9]{48,}$/u;

export function validateCiUrl(environment) {
  if (environment.NODE_ENV === "production" ||
      environment.DISCORD_ENABLED !== "false" ||
      environment.DISCORD_OUTBOUND_ENABLED !== "false" ||
      environment.LLM_PROVIDER !== "disabled")
    throw new Error("CI database commands require disabled Discord, outbound and LLM.");
  const url = new URL(environment.DATABASE_URL ?? "");
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" ||
      url.port !== PORT || url.pathname !== "/" + CI ||
      decodeURIComponent(url.username) !== CI_ROLE ||
      !hex.test(decodeURIComponent(url.password)) ||
      url.search !== "" || url.hash !== "")
    throw new Error("Unsafe CI database target; refusing operation.");
}

export async function inspectIdentity(client, role, database) {
  const result = await client.query(`select current_user as role, current_database() as db,
    current_setting('server_version_num')::int as version,
    rolsuper as superuser, rolcreatedb as createdb, rolcreaterole as createrole
    from pg_roles where rolname = current_user`);
  const row = result.rows[0];
  if (row?.role !== role || row?.db !== database || row?.version < 170000 ||
      row?.version >= 180000 || (role === CI_ROLE &&
      (row?.superuser !== false || row?.createdb !== false || row?.createrole !== false)))
    throw new Error("Local PostgreSQL 17 identity mismatch.");
}

async function main(args) {
  if (args.length !== 1 || !["provision", "check"].includes(args[0]))
    throw new Error("Use provision or check.");
  const mode = args[0];
  if (mode === "provision") {
    const adminPass = process.env.LW_GATEWAY_DEV_ADMIN_PASSWORD;
    const devPass = process.env.LW_GATEWAY_DEV_ROLE_PASSWORD;
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (process.env.NODE_ENV === "production" ||
        process.env.DISCORD_ENABLED !== "false" ||
        process.env.DISCORD_OUTBOUND_ENABLED !== "false" ||
        process.env.LLM_PROVIDER !== "disabled" ||
        !hex.test(adminPass ?? "") || !hex.test(devPass ?? "") ||
        url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" ||
        url.port !== PORT || url.pathname !== "/" + DEV ||
        url.username !== DEV_ROLE || decodeURIComponent(url.password) !== devPass)
      throw new Error("Refusing CI provisioning: unverified local Gateway DEV configuration.");
    const client = new Client({
      host: "127.0.0.1", port: Number(PORT), database: "postgres",
      user: "postgres", password: adminPass, connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      await inspectIdentity(client, "postgres", "postgres");
      const dev = await client.query("select pg_get_userbyid(datdba) as owner from pg_database where datname = $1", [DEV]);
      if (dev.rowCount !== 1 || dev.rows[0].owner !== DEV_ROLE)
        throw new Error("Gateway DEV owner or database is missing; no changes made.");
      const existingRole = await client.query("select 1 from pg_roles where rolname = $1", [CI_ROLE]);
      const existingDb = await client.query("select pg_get_userbyid(datdba) as owner from pg_database where datname = $1", [CI]);
      if (existingDb.rowCount && (existingDb.rowCount !== 1 || existingDb.rows[0].owner !== CI_ROLE))
        throw new Error("Existing CI database owner mismatch; no changes made.");
      let password;
      try {
        const saved = await readFile(path, "utf8");
        password = /^LW_GATEWAY_CI_ROLE_PASSWORD=([a-f0-9]{48,})$/mu.exec(saved)?.[1];
        if (!password) throw new Error("Existing CI config is malformed.");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        if (existingRole.rowCount || existingDb.rowCount)
          throw new Error("CI role already exists but private credential file is missing; manual recovery required.");
        password = randomBytes(32).toString("hex");
        const content = [
          "# Private local-only CI identity. Do not share.",
          "LW_GATEWAY_CI_ROLE_PASSWORD=" + password,
          "DATABASE_URL=postgresql://" + CI_ROLE + ":" + password + "@127.0.0.1:" + PORT + "/" + CI,
          "DISCORD_ENABLED=false", "DISCORD_OUTBOUND_ENABLED=false", "LLM_PROVIDER=disabled", "",
        ].join("\n");
        const handle = await open(path, "wx", 0o600);
        try { await handle.writeFile(content); } finally { await handle.close(); }
      }
      if (!hex.test(password ?? "")) throw new Error("Invalid private CI credential.");
      if (!existingRole.rowCount) {
        await client.query("CREATE ROLE lw_gateway_ci LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + password + "'");
      }
      if (!existingDb.rowCount) await client.query("CREATE DATABASE living_world_ci OWNER lw_gateway_ci");
      await client.query("REVOKE CONNECT, TEMPORARY ON DATABASE living_world_gateway_dev FROM PUBLIC");
      await client.query("REVOKE CONNECT, TEMPORARY ON DATABASE living_world_ci FROM PUBLIC");
      await client.query("GRANT CONNECT ON DATABASE living_world_gateway_dev TO lw_gateway_dev");
      await client.query("GRANT CONNECT ON DATABASE living_world_ci TO lw_gateway_ci");
      const role = await client.query("select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname=$1", [CI_ROLE]);
      if (role.rowCount !== 1 || role.rows[0].rolsuper || role.rows[0].rolcreatedb || role.rows[0].rolcreaterole)
        throw new Error("CI role has elevated privileges.");
      const grant = await client.query("select has_database_privilege($1,$2,'CONNECT') as allowed", [CI_ROLE, DEV]);
      if (grant.rows[0]?.allowed !== false)
        throw new Error("CI role must not have access to persistent DEV database.");
    } finally {
      await client.end();
    }
    console.info("Persistent CI identity provisioned without resetting DEV. Run pnpm dev:ci:check.");
    return;
  }
  validateCiUrl(process.env);
  const client = new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
  await client.connect();
  try {
    await inspectIdentity(client, CI_ROLE, CI);
    const grant = await client.query("select has_database_privilege(current_user,$1,'CONNECT') as allowed", [DEV]);
    if (grant.rows[0]?.allowed !== false)
      throw new Error("CI role can access DEV; refusing to run tests.");
    const schema = await client.query("select current_schema() as name");
    if (schema.rows[0]?.name !== "public") throw new Error("Unexpected CI search path.");
  } finally { await client.end(); }
  console.info("Safe reusable local PostgreSQL 17 CI database verified.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main(process.argv.slice(2)).catch(() => {
    console.error("Local CI DB preflight/provision failed safely; inspect Docker and private credentials.");
    process.exitCode=1;
  });
