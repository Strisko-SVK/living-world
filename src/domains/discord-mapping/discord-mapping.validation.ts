import { z } from "zod";

import {
  discordContextMappingStatusValues,
  discordContextMappingTypeValues,
  discordIdentityMappingTypeValues,
  discordIdentityStatusValues,
} from "../../db/schema/enums.js";

const discordId = z.string().trim().min(1).max(2_000);

export const mapDiscordUserToEntityInputSchema = z.object({
  discordUserId: discordId,
  entityId: z.string().uuid(),
  mappingType: z.enum(discordIdentityMappingTypeValues),
  isPrimary: z.boolean().default(false),
  status: z.enum(discordIdentityStatusValues).default("active"),
});

export const listDiscordUserMappingsInputSchema = z.object({
  discordUserId: discordId,
  status: z.enum(discordIdentityStatusValues).optional(),
});

export const mapDiscordContextInputSchema = z.object({
  contextId: z.string().uuid(),
  guildId: discordId,
  channelId: discordId,
  threadId: discordId.nullable().optional(),
  mappingType: z.enum(discordContextMappingTypeValues),
  status: z.enum(discordContextMappingStatusValues).default("active"),
});

export const discordLocationInputSchema = z.object({
  guildId: discordId,
  channelId: discordId,
  threadId: discordId.nullable().optional(),
});

export type MapDiscordUserToEntityInput = z.input<
  typeof mapDiscordUserToEntityInputSchema
>;
export type MapDiscordContextInput = z.input<
  typeof mapDiscordContextInputSchema
>;
