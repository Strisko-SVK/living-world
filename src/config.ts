import { z } from "zod";
import { getLlmConfig } from "./llm/config.js";

const requiredIntents = ["Guilds", "GuildMessages", "MessageContent"] as const;
const environmentSchema = z.object({
  DISCORD_ENABLED: z.enum(["true", "false"]).default("false"),
  DISCORD_TOKEN: z.string().regex(/^\S+$/).optional(),
  DISCORD_INTENTS: z.string().default(requiredIntents.join(",")),
});

export type ApplicationConfig = ReturnType<typeof getApplicationConfig>;

export function getApplicationConfig(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const result = environmentSchema.safeParse(environment);
  // Never include Zod input values, particularly the token, in diagnostics.
  if (!result.success) throw new Error("Invalid application configuration.");
  const enabled = result.data.DISCORD_ENABLED === "true";
  const intents = result.data.DISCORD_INTENTS.split(",").map((value) =>
    value.trim(),
  );
  if (
    intents.length !== requiredIntents.length ||
    !requiredIntents.every((intent) => intents.includes(intent))
  ) {
    throw new Error(
      "DISCORD_INTENTS must contain exactly Guilds,GuildMessages,MessageContent.",
    );
  }
  if (enabled && !result.data.DISCORD_TOKEN)
    throw new Error("DISCORD_TOKEN is required when Discord is enabled.");
  return {
    llm: getLlmConfig(environment),
    discord: {
      enabled,
      token: result.data.DISCORD_TOKEN,
      intents: [...requiredIntents],
    },
  };
}
