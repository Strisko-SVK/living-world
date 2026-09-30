import { z } from "zod";

import {
  communicationModeValues,
  interactionContextStatusValues,
  interactionContextTypeValues,
  interactionStatusValues,
  interactionTypeValues,
} from "../../db/schema/enums.js";

const externalId = z.string().trim().min(1).max(2_000).nullable().optional();
const optionalJson = z.record(z.string(), z.unknown()).nullable().optional();

export const createInteractionContextInputSchema = z.object({
  contextType: z.enum(interactionContextTypeValues),
  externalProvider: externalId,
  externalGuildId: externalId,
  externalChannelId: externalId,
  externalThreadId: externalId,
  linkedLocationEntityId: z.string().uuid().nullable().optional(),
  status: z.enum(interactionContextStatusValues).default("active"),
  metadata: optionalJson,
});

export const findInteractionContextByExternalRefInputSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  guildId: externalId,
  channelId: externalId,
  threadId: externalId,
});

export const createInteractionInputSchema = z.object({
  contextId: z.string().uuid(),
  speakerEntityId: z.string().uuid().nullable().optional(),
  interactionType: z.enum(interactionTypeValues),
  intentType: z.enum(interactionTypeValues).nullable().optional(),
  communicationMode: z.enum(communicationModeValues),
  requestText: z
    .string()
    .trim()
    .min(1, "Request text is required.")
    .max(20_000),
  sourceMessageId: externalId,
  traceId: z.string().uuid().optional(),
});

export const recordInteractionResponseInputSchema = z.object({
  responseText: z
    .string()
    .trim()
    .min(1, "Response text is required.")
    .max(20_000),
  responseMessageId: externalId,
});

export const failInteractionInputSchema = z.object({
  reason: z.string().trim().min(1).max(2_000).optional(),
});

export const listInteractionsFilterSchema = z.object({
  contextId: z.string().uuid().optional(),
  status: z.enum(interactionStatusValues).optional(),
  interactionType: z.enum(interactionTypeValues).optional(),
  traceId: z.string().uuid().optional(),
});

export type CreateInteractionContextInput = z.input<
  typeof createInteractionContextInputSchema
>;
export type CreateInteractionInput = z.input<
  typeof createInteractionInputSchema
>;
export type RecordInteractionResponseInput = z.input<
  typeof recordInteractionResponseInputSchema
>;
export type ListInteractionsFilters = z.input<
  typeof listInteractionsFilterSchema
>;
