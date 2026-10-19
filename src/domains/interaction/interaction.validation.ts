import { z } from "zod";

import {
  communicationModeValues,
  interactionContextStatusValues,
  interactionContextTypeValues,
  interactionStatusValues,
  interactionTypeValues,
} from "../../db/schema/enums.js";

// Provider identifiers are opaque strings, never numbers or normalized text.
const opaqueReference = z
  .string()
  .min(1)
  .max(2_000)
  .regex(
    /^[^\s\p{Cc}]+$/u,
    "External references must not contain whitespace or control characters.",
  );
const externalId = opaqueReference.nullable().optional();
const optionalJson = z.record(z.string(), z.unknown()).nullable().optional();

export const createInteractionContextInputSchema = z
  .object({
    contextType: z.enum(interactionContextTypeValues),
    externalProvider: opaqueReference.max(100).nullable().optional(),
    externalGuildId: externalId,
    externalChannelId: externalId,
    externalThreadId: externalId,
    linkedLocationEntityId: z.string().uuid().nullable().optional(),
    status: z.enum(interactionContextStatusValues).default("active"),
    metadata: optionalJson,
  })
  .superRefine((value, context) => {
    if (
      (value.externalGuildId ||
        value.externalChannelId ||
        value.externalThreadId) &&
      !value.externalProvider
    ) {
      context.addIssue({
        code: "custom",
        path: ["externalProvider"],
        message: "External location references require a provider.",
      });
    }
    if (
      (value.externalGuildId || value.externalThreadId) &&
      !value.externalChannelId
    ) {
      context.addIssue({
        code: "custom",
        path: ["externalChannelId"],
        message: "Guild and thread references require a channel.",
      });
    }
  });

export const findInteractionContextByExternalRefInputSchema = z
  .object({
    provider: opaqueReference.max(100),
    guildId: externalId,
    channelId: externalId,
    threadId: externalId,
  })
  .superRefine((value, context) => {
    if ((value.guildId || value.threadId) && !value.channelId) {
      context.addIssue({
        code: "custom",
        path: ["channelId"],
        message: "Guild and thread references require a channel.",
      });
    }
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
