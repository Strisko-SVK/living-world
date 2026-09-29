import { z } from "zod";

const databaseUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "postgres:" || protocol === "postgresql:";
      } catch {
        return false;
      }
    },
    {
      message:
        "DATABASE_URL must use the postgres:// or postgresql:// protocol.",
    },
  );

export interface DatabaseConfig {
  databaseUrl: string;
}

export function getDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const databaseUrl = environment.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "Invalid database configuration: DATABASE_URL is required.",
    );
  }

  const result = databaseUrlSchema.safeParse(databaseUrl);

  if (!result.success) {
    throw new Error(
      "Invalid database configuration: DATABASE_URL must be a valid PostgreSQL URL.",
    );
  }

  return { databaseUrl: result.data };
}
