import console from "node:console";
import { randomBytes } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";

export async function initialiseLocalEnvironment(
  examplePath = ".env.example",
  targetPath = ".env",
) {
  const template = await readFile(examplePath, "utf8");
  if (
    !/^DATABASE_URL=$/m.test(template) ||
    !/^POSTGRES_PASSWORD=$/m.test(template)
  ) {
    throw new Error("Expected an empty credential template.");
  }
  const password = randomBytes(32).toString("hex");
  const contents = template
    .replace(
      /^DATABASE_URL=$/m,
      `DATABASE_URL=postgresql://living_world:${password}@127.0.0.1:5432/living_world`,
    )
    .replace(/^POSTGRES_PASSWORD=$/m, `POSTGRES_PASSWORD=${password}`);
  const file = await open(targetPath, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
  } finally {
    await file.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  initialiseLocalEnvironment().then(
    () =>
      console.info(
        "Created private .env. Credentials were not printed. Existing DB passwords are unchanged.",
      ),
    () => {
      console.error(
        "Environment creation refused or failed; existing credentials were not overwritten.",
      );
      process.exitCode = 1;
    },
  );
}
