import { z } from "zod";
import {
  incomingMessageSchema,
  type IncomingMessage,
} from "../intake/discord-intake.js";
import { parseDiscordTrigger } from "../intake/discord-trigger.js";
import {
  createOfflineSceneHandshake,
  type SceneHandshakeDependencies,
  type SceneHandshakeResult,
  type SceneRequest,
} from "./npc-scene-handshake.js";

const scopeSchema = z
  .object({
    worldId: z.string().uuid(),
    contextId: z.string().uuid(),
  })
  .strict();

type TrustedPorts = Omit<SceneHandshakeDependencies, "intake">;

export type OfflineGatewaySceneDependencies = TrustedPorts & {
  // Resolve from mapped DB state, never from an asserted event scope.
  resolveScene(message: IncomingMessage): Promise<unknown>;
  // Called with the exact normalized adapter event and authenticated client ID.
  intake(message: IncomingMessage, botId: string): Promise<string>;
};

// Test-only composition boundary: intended solely as the callback passed into
// createDiscordAdapter. That adapter obtains botId from client.user.id, not
// caller text. This module cannot connect to Discord or send any message.
export function createOfflineGatewaySceneBridge(
  deps: OfflineGatewaySceneDependencies,
) {
  return async (
    input: IncomingMessage,
    authenticatedBotId: string,
  ): Promise<SceneHandshakeResult> => {
    if (process.env.NODE_ENV !== "test") return "offline_only";
    const parsed = incomingMessageSchema.safeParse(input);
    if (!parsed.success) return "invalid_request";
    const message = parsed.data;
    if (
      !parseDiscordTrigger(
        message.content,
        authenticatedBotId,
        message.mentionedUserIds,
      )
    )
      return "intake_denied";

    let scene: unknown;
    try {
      scene = await deps.resolveScene(message);
    } catch {
      return "intake_denied";
    }
    const resolved = scopeSchema.safeParse(scene);
    if (!resolved.success) return "intake_denied";
    const request: SceneRequest = {
      ...resolved.data,
      sourceMessageId: message.sourceMessageId,
      guildId: message.guildId,
      channelId: message.channelId,
      threadId: message.threadId,
      authorId: message.authorId,
    };
    return createOfflineSceneHandshake({
      received: deps.received,
      presence: deps.presence,
      prepare: deps.prepare,
      respond: deps.respond,
      // Capture the original normalized SDK event and authenticated bot ID.
      // The coordinator cannot substitute a different event in this port.
      intake: () => deps.intake(message, authenticatedBotId),
    })(request);
  };
}
