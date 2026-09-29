import { z } from "zod";

import {
  relationshipEventTypeValues,
  relationshipIntentValues,
} from "../../db/schema/enums.js";

export const relationshipDimensionKeys = [
  "familiarity",
  "trust",
  "respect",
  "affection",
  "fear",
  "resentment",
  "dependence",
  "obligation",
] as const;

const dimension = z.number().int().min(0).max(100);
const deltaValue = z.number().int().min(-100).max(100);

export const relationshipEndpointsSchema = z
  .object({
    sourceEntityId: z.string().uuid(),
    targetEntityId: z.string().uuid(),
  })
  .refine((value) => value.sourceEntityId !== value.targetEntityId, {
    message: "A relationship requires distinct source and target entities.",
    path: ["targetEntityId"],
  });

export const createRelationshipInputSchema = z.object({
  familiarity: dimension.default(0),
  trust: dimension.default(50),
  respect: dimension.default(50),
  affection: dimension.default(0),
  fear: dimension.default(0),
  resentment: dimension.default(0),
  dependence: dimension.default(0),
  obligation: dimension.default(0),
  intent: z.enum(relationshipIntentValues).nullable().optional(),
  utility: z.unknown().nullable().optional(),
});

export const relationshipDeltaSchema = z
  .object({
    familiarity: deltaValue.optional(),
    trust: deltaValue.optional(),
    respect: deltaValue.optional(),
    affection: deltaValue.optional(),
    fear: deltaValue.optional(),
    resentment: deltaValue.optional(),
    dependence: deltaValue.optional(),
    obligation: deltaValue.optional(),
  })
  .strict()
  .refine(
    (value) =>
      relationshipDimensionKeys.some((key) => value[key] !== undefined),
    "Relationship delta must change at least one dimension.",
  );

export const applyRelationshipEventInputSchema = z.object({
  eventType: z.enum(relationshipEventTypeValues),
  delta: relationshipDeltaSchema,
  reasonSummary: z
    .string()
    .trim()
    .min(1, "Relationship event reason is required.")
    .max(2_000),
  sourceInteractionId: z.string().uuid().nullable().optional(),
  sourceMemoryId: z.string().uuid().nullable().optional(),
  sourceKnowledgeId: z.string().uuid().nullable().optional(),
  occurredAt: z.coerce.date().nullable().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export const updateRelationshipIntentSchema = z
  .enum(relationshipIntentValues)
  .nullable();

export type CreateRelationshipInput = z.input<
  typeof createRelationshipInputSchema
>;
export type ApplyRelationshipEventInput = z.input<
  typeof applyRelationshipEventInputSchema
>;
export type RelationshipDelta = z.output<typeof relationshipDeltaSchema>;
export type RelationshipIntentInput = z.input<
  typeof updateRelationshipIntentSchema
>;
