import { z } from "zod";

import { worldStatusValues } from "../../db/schema/enums.js";

export const createWorldInputSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "World key is required.")
    .max(100)
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/,
      "World key must use lowercase letters, numbers, underscores, or hyphens.",
    ),
  name: z.string().trim().min(1, "World name is required.").max(200),
  systemType: z.string().trim().min(1, "System type is required.").max(100),
  status: z.enum(worldStatusValues).default("active"),
  config: z.record(z.string(), z.unknown()).default({}),
});

export type CreateWorldInput = z.input<typeof createWorldInputSchema>;
