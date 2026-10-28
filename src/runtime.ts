import { getApplicationConfig } from "./config.js";
import { createDatabaseClient, checkDatabaseConnection } from "./db/client.js";
import { createDiscordAdapter } from "./adapters/discord/client.js";
import { createDiscordPersistence } from "./adapters/discord/persistence.js";
import {
  createDiscordIntake,
  type Diagnostics,
} from "./intake/discord-intake.js";

// Entry-point wiring only; importing this module does not create a connection.
export async function startApplication(
  environment: NodeJS.ProcessEnv = process.env,
  diagnose: Diagnostics = (diagnostic) =>
    console.info(JSON.stringify(diagnostic)),
) {
  const config = getApplicationConfig(environment);
  if (!config.discord.enabled) {
    diagnose({ event: "discord_disabled" });
    return { stop: async () => {} };
  }
  const database = createDatabaseClient(environment);
  const adapter = createDiscordAdapter(
    config.discord,
    createDiscordIntake(
      createDiscordPersistence(database.db, config.discord.intakeAllowlist),
      diagnose,
      "explicit_alias",
    ),
    diagnose,
  );
  let stopPromise: Promise<void> | undefined;
  const stop = () =>
    (stopPromise ??= (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      try {
        await adapter.stop();
      } finally {
        await database.close();
      }
    })());
  const onSignal = () => {
    void stop().catch(() => {
      diagnose({ event: "shutdown_error" });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await checkDatabaseConnection(database);
    await adapter.start();
    return { stop };
  } catch {
    await stop();
    throw new Error("Application startup failed.");
  }
}
