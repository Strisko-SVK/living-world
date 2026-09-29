import { z } from "zod";

import {
  capabilityLevelValues,
  capabilitySourceValues,
  entityStatusValues,
  locationCertaintyValues,
  npcLifecycleStateValues,
} from "../../db/schema/enums.js";

const textValue = (field: string) =>
  z.string().trim().min(1, `${field} is required.`).max(500);

const structuredDataSchema = z.record(z.string(), z.unknown());
const stateDetailSchema = z
  .object({
    summary: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const baselineProfileSchema = z
  .object({
    identity: z
      .object({
        name: textValue("Baseline identity name"),
        species: textValue("Baseline species"),
        role: textValue("Baseline role"),
      })
      .strict(),
    summary: textValue("Baseline summary"),
    personality: z
      .object({
        traits: z.array(textValue("Personality trait")).min(1).max(12),
        values: z.array(textValue("Personality value")).max(12).default([]),
      })
      .strict(),
  })
  .strict();

export const npcStateInputSchema = z.object({
  currentLocationId: z.string().uuid().nullable().default(null),
  locationCertainty: z.enum(locationCertaintyValues).default("unknown"),
  physicalState: stateDetailSchema.default({}),
  emotionalState: stateDetailSchema.default({}),
  materialState: stateDetailSchema.default({}),
  availabilityState: stateDetailSchema.default({}),
});

export const updateNpcStateInputSchema = z
  .object({
    currentLocationId: z.string().uuid().nullable().optional(),
    locationCertainty: z.enum(locationCertaintyValues).optional(),
    physicalState: stateDetailSchema.optional(),
    emotionalState: stateDetailSchema.optional(),
    materialState: stateDetailSchema.optional(),
    availabilityState: stateDetailSchema.optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .refine(
    (value) =>
      value.currentLocationId !== undefined ||
      value.locationCertainty !== undefined ||
      value.physicalState !== undefined ||
      value.emotionalState !== undefined ||
      value.materialState !== undefined ||
      value.availabilityState !== undefined,
    "At least one NPC state field must be provided.",
  );

export const npcGameProfileInputSchema = z.object({
  gameSystem: textValue("Game system"),
  statDepth: z.number().int().min(0).max(3),
  characteristics: structuredDataSchema.default({}),
  skills: structuredDataSchema.default({}),
  talents: structuredDataSchema.default({}),
  combat: structuredDataSchema.default({}),
  gear: structuredDataSchema.default({}),
  derivedValues: structuredDataSchema.default({}),
  sourceNotes: structuredDataSchema.default({}),
});

export const npcCapabilityInputSchema = z.object({
  capabilityKey: z
    .string()
    .trim()
    .regex(
      /^[a-z][a-z0-9_]*$/,
      "Capability key must use lowercase letters, numbers, and underscores.",
    )
    .max(100),
  level: z.enum(capabilityLevelValues),
  source: z.enum(capabilitySourceValues),
  confidence: z.number().min(0).max(1),
});

export const createNpcInputSchema = z.object({
  canonicalName: textValue("Canonical name").max(200),
  entityStatus: z.enum(entityStatusValues).default("active"),
  simulationDepth: z.number().int().min(0).max(3),
  narrativeWeight: z.number().int().min(0).max(100),
  lifecycleState: z.enum(npcLifecycleStateValues).default("active"),
  canonProtected: z.boolean().default(false),
  templateVersion: z.number().int().positive().default(1),
  profileVersion: z.number().int().positive().default(1),
  baselineProfile: baselineProfileSchema,
  initialState: npcStateInputSchema.default(() =>
    npcStateInputSchema.parse({}),
  ),
  gameProfile: npcGameProfileInputSchema.optional(),
  capabilities: z.array(npcCapabilityInputSchema).default([]),
});

export type CreateNpcInput = z.input<typeof createNpcInputSchema>;
export type UpdateNpcStateInput = z.input<typeof updateNpcStateInputSchema>;
export type NpcGameProfileInput = z.input<typeof npcGameProfileInputSchema>;
export type NpcCapabilityInput = z.input<typeof npcCapabilityInputSchema>;
