import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "./config.js";

export function createDatabaseClient(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const { databaseUrl } = getDatabaseConfig(environment);
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle({ client: pool });

  return {
    db,
    pool,
    close: async () => pool.end(),
  };
}

export type DatabaseClient = ReturnType<typeof createDatabaseClient>;

export async function checkDatabaseConnection(
  database: DatabaseClient,
): Promise<boolean> {
  await database.db.execute(sql`SELECT 1`);
  return true;
}
