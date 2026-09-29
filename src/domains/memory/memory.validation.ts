import { z } from "zod";

import {
  memoryDetailLevelValues,
  memoryRelationTypeValues,
  memoryRetentionClassValues,
  memorySourceTypeValues,
  memoryStatusValues,
  memoryTypeValues,
} from "../../db/schema/enums.js";

const optionalText = z.string().trim().min(1).max(2_000).nullable().optional();

export const createMemoryInputSchema = z.object({
  memoryType: z.enum(memoryTypeValues),
  summary: z.string().trim().min(1, "Memory summary is required.").max(2_000),
  importance: z.number().int().min(0).max(100),
  detailLevel: z.enum(memoryDetailLevelValues),
  retentionClass: z.enum(memoryRetentionClassValues),
  status: z.enum(memoryStatusValues).default("active"),
  emotionalTags: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  occurredAt: z.coerce.date().nullable().optional(),
});

export const addMemorySourceInputSchema = z.object({
  sourceType: z.enum(memorySourceTypeValues),
  sourceId: optionalText,
  sourceEntityId: z.string().uuid().nullable().optional(),
  sourceInteractionId: z.string().uuid().nullable().optional(),
  provenanceNote: optionalText,
});

export const addMemoryRelationInputSchema = z
  .object({
    parentMemoryId: z.string().uuid(),
    childMemoryId: z.string().uuid(),
    relationType: z.enum(memoryRelationTypeValues),
  })
  .refine((value) => value.parentMemoryId !== value.childMemoryId, {
    message: "A memory cannot have a relation to itself.",
    path: ["childMemoryId"],
  });

export const updateMemoryStatusInputSchema = z.object({
  status: z.enum(memoryStatusValues),
});

export const listMemoriesFilterSchema = z.object({
  status: z.enum(memoryStatusValues).optional(),
  memoryType: z.enum(memoryTypeValues).optional(),
  retentionClass: z.enum(memoryRetentionClassValues).optional(),
});

export type CreateMemoryInput = z.input<typeof createMemoryInputSchema>;
export type AddMemorySourceInput = z.input<typeof addMemorySourceInputSchema>;
export type AddMemoryRelationInput = z.input<
  typeof addMemoryRelationInputSchema
>;
export type UpdateMemoryStatusInput = z.input<
  typeof updateMemoryStatusInputSchema
>;
export type ListMemoriesFilters = z.input<typeof listMemoriesFilterSchema>;
