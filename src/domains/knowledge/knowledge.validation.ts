import { z } from "zod";

import {
  knowledgeClassificationValues,
  knowledgeConflictStatusValues,
  knowledgeSecrecyValues,
  knowledgeSourceTypeValues,
  knowledgeStatusValues,
} from "../../db/schema/enums.js";

const optionalText = z.string().trim().min(1).max(2_000).nullable().optional();

export const createKnowledgeInputSchema = z.object({
  subjectEntityId: z.string().uuid().nullable().optional(),
  predicate: optionalText,
  objectEntityId: z.string().uuid().nullable().optional(),
  objectValue: z.unknown().nullable().optional(),
  claimText: z
    .string()
    .trim()
    .min(1, "Knowledge claim text is required.")
    .max(2_000),
  classification: z.enum(knowledgeClassificationValues),
  confidence: z.number().min(0).max(1),
  secrecy: z.enum(knowledgeSecrecyValues),
  status: z.enum(knowledgeStatusValues).default("current"),
  acquiredAt: z.coerce.date().nullable().optional(),
});

export const addKnowledgeSourceInputSchema = z.object({
  sourceType: z.enum(knowledgeSourceTypeValues),
  sourceEntityId: z.string().uuid().nullable().optional(),
  sourceKnowledgeId: z.string().uuid().nullable().optional(),
  sourceMemoryId: z.string().uuid().nullable().optional(),
  externalRef: optionalText,
  chainDepth: z.number().int().min(0).nullable().optional(),
  provenanceNote: optionalText,
});

export const createKnowledgeConflictInputSchema = z
  .object({
    claimAId: z.string().uuid(),
    claimBId: z.string().uuid(),
  })
  .refine((value) => value.claimAId !== value.claimBId, {
    message: "A knowledge conflict requires two distinct claims.",
    path: ["claimBId"],
  });

export const updateKnowledgeStatusInputSchema = z.object({
  status: z.enum(knowledgeStatusValues),
});

export const updateKnowledgeConfidenceInputSchema = z.object({
  confidence: z.number().min(0).max(1),
});

export const listKnowledgeFilterSchema = z.object({
  classification: z.enum(knowledgeClassificationValues).optional(),
  status: z.enum(knowledgeStatusValues).optional(),
  secrecy: z.enum(knowledgeSecrecyValues).optional(),
  subjectEntityId: z.string().uuid().optional(),
});

export const listKnowledgeConflictsFilterSchema = z.object({
  status: z.enum(knowledgeConflictStatusValues).optional(),
});

export type CreateKnowledgeInput = z.input<typeof createKnowledgeInputSchema>;
export type AddKnowledgeSourceInput = z.input<
  typeof addKnowledgeSourceInputSchema
>;
export type CreateKnowledgeConflictInput = z.input<
  typeof createKnowledgeConflictInputSchema
>;
export type UpdateKnowledgeStatusInput = z.input<
  typeof updateKnowledgeStatusInputSchema
>;
export type UpdateKnowledgeConfidenceInput = z.input<
  typeof updateKnowledgeConfidenceInputSchema
>;
export type ListKnowledgeFilters = z.input<typeof listKnowledgeFilterSchema>;
export type ListKnowledgeConflictsFilters = z.input<
  typeof listKnowledgeConflictsFilterSchema
>;
