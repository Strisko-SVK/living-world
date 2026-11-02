import { z } from "zod";
import { identitySchema } from "../../delivery/contracts.js";
import type {
  DeliveryPayload,
  DeliveryScope,
} from "../../delivery/contracts.js";
const configurations = new WeakSet<object>();
const approvals = new WeakSet<object>();
export const isApprovedTarget = (value: object) => approvals.has(value);
export const snowflake = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/u)
  .refine((s) => {
    try {
      return BigInt(s) <= (1n << 64n) - 1n;
    } catch {
      return false;
    }
  });
export const targetSchema = z
  .object({
    worldId: z.string().uuid(),
    guildId: snowflake,
    channelId: snowflake,
    threadId: snowflake.nullable(),
  })
  .strict();
export type OutboundTarget = z.infer<typeof targetSchema>;
const bindingSchema = z
  .object({
    worldId: z.string().uuid(),
    guildId: snowflake,
    channelId: snowflake,
    threadIds: z
      .array(snowflake.nullable())
      .min(1)
      .max(16)
      .refine((a) => new Set(a).size === a.length),
    webhookId: snowflake,
    credentialVersion: z.string().uuid(),
  })
  .strict();
const credentialSchema = z
  .object({
    webhookId: snowflake,
    version: z.string().uuid(),
    token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
  })
  .strict();
export type WebhookBinding = z.infer<typeof bindingSchema>;
export type WebhookCredential = z.infer<typeof credentialSchema>;
export class OutboundBlocked extends Error {
  constructor(readonly reason: string) {
    super("Discord outbound operation blocked.");
  }
}
export function readOutboundConfiguration(env: NodeJS.ProcessEnv) {
  try {
    if (env.DISCORD_OUTBOUND_ENABLED !== "true")
      throw new OutboundBlocked("outbound_disabled");
    const bindings = z
      .array(bindingSchema)
      .min(1)
      .max(16)
      .parse(JSON.parse(env.DISCORD_OUTBOUND_ALLOWLIST ?? ""));
    const credentials = z
      .array(credentialSchema)
      .min(1)
      .max(16)
      .parse(JSON.parse(env.DISCORD_OUTBOUND_CREDENTIALS ?? ""));
    const avatars = z
      .array(
        z
          .object({
            worldId: z.string().uuid(),
            npcId: z.string().uuid(),
            avatarUrl: identitySchema.shape.avatarUrl.unwrap(),
          })
          .strict(),
      )
      .max(16)
      .parse(JSON.parse(env.DISCORD_OUTBOUND_AVATARS ?? "[]"));
    const avatarKeys = avatars.map((a) => `${a.worldId}:${a.npcId}`);
    if (
      new Set(avatarKeys).size !== avatarKeys.length ||
      avatars.some((a) => !bindings.some((b) => b.worldId === a.worldId))
    )
      throw Error();
    avatars.forEach(Object.freeze);
    Object.freeze(avatars);
    const keys = bindings.map(
      (b) => `${b.worldId}:${b.guildId}:${b.channelId}`,
    );
    if (
      new Set(keys).size !== keys.length ||
      new Set(credentials.map((c) => c.webhookId)).size !== credentials.length
    )
      throw Error();
    for (const b of bindings)
      if (
        bindings.some(
          (other) =>
            other.webhookId === b.webhookId &&
            (other.guildId !== b.guildId || other.channelId !== b.channelId),
        )
      )
        throw Error();
    for (const b of bindings) {
      Object.freeze(b.threadIds);
      Object.freeze(b);
    }
    credentials.forEach(Object.freeze);
    Object.freeze(bindings);
    Object.freeze(credentials);
    const result = Object.freeze({ bindings, credentials, avatars });
    configurations.add(result);
    return result;
  } catch (error) {
    if (error instanceof OutboundBlocked) throw error;
    throw new OutboundBlocked("invalid_configuration");
  }
}
export function authorizeTarget(
  config: ReturnType<typeof readOutboundConfiguration>,
  input: OutboundTarget,
) {
  if (!configurations.has(config))
    throw new OutboundBlocked("invalid_configuration");
  const parsed = targetSchema.safeParse(input);
  if (!parsed.success) throw new OutboundBlocked("invalid_target");
  const target = parsed.data;
  const binding = config.bindings.find(
    (b) =>
      b.worldId === target.worldId &&
      b.guildId === target.guildId &&
      b.channelId === target.channelId &&
      b.threadIds.includes(target.threadId),
  );
  if (!binding) throw new OutboundBlocked("target_not_allowed");
  const credential = config.credentials.find(
    (c) =>
      c.webhookId === binding.webhookId &&
      c.version === binding.credentialVersion,
  );
  if (!credential) throw new OutboundBlocked("credential_unavailable");
  const result = {
    target: structuredClone(target),
    binding: structuredClone(binding),
    credential: structuredClone(credential),
  };
  Object.freeze(result.target);
  Object.freeze(result.binding.threadIds);
  Object.freeze(result.binding);
  Object.freeze(result.credential);
  Object.freeze(result);
  approvals.add(result);
  return result;
}
export type AuthorizedTarget = ReturnType<typeof authorizeTarget>;
export function matchesTarget(
  payload: DeliveryPayload,
  target: OutboundTarget,
  scope?: DeliveryScope,
) {
  const d = payload.destination;
  return (
    payload.scope.worldId === target.worldId &&
    d.guildId === target.guildId &&
    d.channelId === target.channelId &&
    d.threadId === target.threadId &&
    (!scope ||
      (payload.scope.npcId === scope.npcId &&
        payload.scope.interactionId === scope.interactionId &&
        payload.scope.worldId === scope.worldId))
  );
}
