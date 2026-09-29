import { z } from "zod";

import { entityStatusValues, entityTypeValues } from "../../db/schema/enums.js";

export const createEntityInputSchema = z.object({
  entityType: z.enum(entityTypeValues),
  canonicalName: z
    .string()
    .trim()
    .min(1, "Canonical name is required.")
    .max(200),
  status: z.enum(entityStatusValues).default("active"),
});

export const addEntityAliasInputSchema = z.object({
  alias: z.string().trim().min(1, "Alias is required.").max(200),
});

export type CreateEntityInput = z.input<typeof createEntityInputSchema>;
export type AddEntityAliasInput = z.input<typeof addEntityAliasInputSchema>;
