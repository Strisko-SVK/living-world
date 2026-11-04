import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { createDatabaseClient } from "../db/client.js";

export const gatewayDevConfigPath = ".env.gateway-dev.local";
const dbName = "living_world_gateway_dev";
const dbUser = "lw_gateway_dev";
const dbPort = "55432";

export function renderGatewayDevConfig(adminPassword: string, rolePassword: string): string {
  if (!/^[a-f0-9]{48,}$/u.test(adminPassword) || !/^[a-f0-9]{48,}$/u.test(rolePassword))
    throw new Error("DEV passwords must be long hex strings.");
  return [
    "# Local-only secrets. Never copy to Git, Notion, chat or CI logs.",
    `LW_GATEWAY_DEV_ADMIN_PASSWORD=${adminPassword}`,
    `LW_GATEWAY_DEV_ROLE_PASSWORD=${rolePassword}`,
    `DATABASE_URL=postgresql://${dbUser}:${rolePassword}@127.0.0.1:${dbPort}/${dbName}`,
    "DISCORD_ENABLED=false",
    "DISCORD_OUTBOUND_ENABLED=false",
    "LLM_PROVIDER=disabled",
    "# Fill the three nonsecret Discord route IDs from Notion section 8.",
    "LW_DEV_GUILD_ID=",
    "LW_DEV_PARENT_CHANNEL_ID=",
    "LW_DEV_THREAD_ID=",
    "",
  ].join("\n");
}

export async function writeGatewayDevConfig(
  path = gatewayDevConfigPath,
  random: (size: number) => Buffer = randomBytes,
): Promise<void> {
  const contents = renderGatewayDevConfig(
    random(32).toString("hex"),
    random(32).toString("hex"),
  );
  // wx rejects overwriting any existing credentials.
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
  } finally {
    await file.close();
  }
}

export function validateGatewayDevDatabaseEnv(environment: NodeJS.ProcessEnv): void {
  if (
    environment.NODE_ENV === "production" ||
    environment.DISCORD_ENABLED !== "false" ||
    environment.DISCORD_OUTBOUND_ENABLED !== "false" ||
    environment.LLM_PROVIDER !== "disabled"
  ) throw new Error("DEV commands require Discord, outbound and LLM disabled.");
  const rolePassword = environment.LW_GATEWAY_DEV_ROLE_PASSWORD;
  const adminPassword = environment.LW_GATEWAY_DEV_ADMIN_PASSWORD;
  if (!rolePassword || !adminPassword)
    throw new Error("Dedicated DEV credentials are missing.");
  let url: URL;
  try {
    url = new URL(environment.DATABASE_URL ?? "");
  } catch {
    throw new Error("DEV database URL is invalid.");
  }
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== dbPort ||
    url.pathname !== `/${dbName}` ||
    decodeURIComponent(url.username) !== dbUser ||
    decodeURIComponent(url.password) !== rolePassword ||
    url.search !== "" ||
    url.hash !== ""
  ) throw new Error("DEV endpoint is not the dedicated local target.");
}

export async function verifyGatewayDevDatabase(
  environment: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
): Promise<void> {
  validateGatewayDevDatabaseEnv(environment);
  const client = connect(environment);
  try {
    await client.db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const result = await tx.execute(sql`
        select current_database() as database, current_user as db_role,
          current_setting('server_version_num')::int as version,
          rol.rolsuper as superuser, rol.rolcreatedb as createdb,
          rol.rolcreaterole as createrole,
          (select pg_get_userbyid(datdba) from pg_database where datname=current_database()) as db_owner
        from pg_roles rol where rol.rolname=current_user
      `);
      const row = result.rows[0];
      if (
        !row ||
        row.database !== dbName ||
        row.db_role !== dbUser ||
        row.db_owner !== dbUser ||
        typeof row.version !== "number" ||
        row.version < 170000 ||
        row.version >= 180000 ||
        row.superuser !== false ||
        row.createdb !== false ||
        row.createrole !== false
      ) throw new Error("DEV DB identity or privileges are not approved.");
    });
  } finally {
    await client.close();
  }
}

function runMigrations(environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["./node_modules/drizzle-kit/bin.cjs", "migrate"], {
      stdio: "inherit",
      env: environment,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`DEV migration failed (exit ${code ?? signal).`));
    });
  });
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length !== 1) throw new Error("Use init, check or migrate.");
  if (args[0] === "init") {
    await writeGatewayDevConfig();
    console.info(`Created ${gatewayDevConfigPath}. Keep secrets private and fill route IDs locally.`);
    return;
  }
  if (args[0] !== "check" && args[0] !== "migrate")
    throw new Error("Use init, check or migrate.");
  await verifyGatewayDevDatabase();
  if (args[0] === "migrate") await runMigrations(process.env);
  console.info(args[0] === "migrate" ? "DEV migrations completed." : "DEV database identity verified.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).catch(() => {
    // Intentionally do not print secrets, connection strings, SQL or env dumps.
    console.error("DEV DB command failed safely; check local Docker and credentials.");
    process.exitCode = 1;
  });
}
