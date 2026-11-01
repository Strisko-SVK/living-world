import { createHash } from "node:crypto";
import { z } from "zod";

export const MAX_ATTEMPTS = 3;
export const LEASE_MS = 60_000;
export const scopeSchema = z
  .object({
    worldId: z.string().uuid(),
    npcId: z.string().uuid(),
    interactionId: z.string().uuid(),
  })
  .strict();
export type DeliveryScope = z.infer<typeof scopeSchema>;
export const reference = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9:_-]+$/u);
const avatar = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "cdn.discordapp.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^\/avatars\/\d+\/[a-fA-F0-9_]+\.(png|webp|jpg)$/u.test(url.pathname)
    );
  });
export const identitySchema = z
  .object({
    displayName: z
      .string()
      .min(1)
      .max(80)
      .refine(
        (s) =>
          s === s.trim() &&
          !/[@<>\p{Cc}\p{Cf}]/u.test(s) &&
          !["everyone", "here", "discord", "clyde"].includes(s.toLowerCase()),
      ),
    avatarUrl: avatar.nullable(),
  })
  .strict();
export type NpcDeliveryIdentity = z.infer<typeof identitySchema>;
export const destinationSchema = z
  .object({
    provider: z.literal("discord"),
    guildId: reference,
    channelId: reference,
    threadId: reference.nullable(),
  })
  .strict();
export const payloadSchema = z
  .object({
    scope: scopeSchema,
    destination: destinationSchema,
    replyToMessageId: reference,
    identity: identitySchema,
    content: z
      .string()
      .min(1)
      .max(2000)
      .refine((s) => s.trim().length > 0 && s.length <= 2000),
    allowedMentions: z
      .object({
        parse: z.tuple([]),
        users: z.tuple([]),
        roles: z.tuple([]),
        repliedUser: z.literal(false),
      })
      .strict(),
  })
  .strict();
export type DeliveryPayload = z.infer<typeof payloadSchema>;
export const fingerprint = (payload: DeliveryPayload) =>
  createHash("sha256")
    .update(JSON.stringify(payloadSchema.parse(payload)))
    .digest("hex");
export const acknowledgementSchema = z
  .object({
    attemptId: z.string().uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    destination: destinationSchema,
    messageId: reference,
  })
  .strict();
export type DeliveryAcknowledgement = z.infer<typeof acknowledgementSchema>;
export const transportResultSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("acknowledged"), ack: acknowledgementSchema })
    .strict(),
  z
    .object({
      kind: z.literal("not_sent"),
      retryable: z.boolean(),
      retryAfterMs: z.number().int().min(0).max(86_400_000),
    })
    .strict(),
  z.object({ kind: z.literal("uncertain") }).strict(),
]);
export type TransportResult = z.infer<typeof transportResultSchema>;
export interface DeliveryTransport {
  send(request: {
    payload: DeliveryPayload;
    attemptId: string;
    fingerprint: string;
  }): Promise<TransportResult>;
}
export function retryDelay(attempt: number, retryAfterMs: number) {
  return Math.max(1000 * 2 ** (attempt - 1), retryAfterMs);
}
