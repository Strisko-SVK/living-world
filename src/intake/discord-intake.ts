import { randomUUID } from "node:crypto";
import { z } from "zod";

const reference = z
  .string()
  .min(1)
  .max(2000)
  .regex(/^[^\s\p{Cc}]+$/u);
export const incomingMessageSchema = z.object({
  sourceMessageId: reference,
  authorId: reference,
  guildId: reference,
  channelId: reference,
  threadId: reference.nullable(),
  content: z.string().trim().min(1).max(20_000),
  mentionedUserIds: z.array(reference).max(100),
});
export type IncomingMessage = z.infer<typeof incomingMessageSchema>;
export type IntakeDiagnostic = {
  event: string;
  outcome?: string;
  targets?: number;
};
export type Diagnostics = (diagnostic: IntakeDiagnostic) => void;
export interface IdentityMapping {
  entityId: string;
  isPrimary: boolean;
  mappingType: string;
}
export interface ResolvedContext {
  id: string;
  worldId: string;
  status: string;
}
export interface IntakePersistence {
  worldIds(message: IncomingMessage): Promise<string[]>;
  context(
    worldId: string,
    message: IncomingMessage,
  ): Promise<ResolvedContext | null>;
  identities(worldId: string, userId: string): Promise<IdentityMapping[]>;
  isNpc(worldId: string, entityId: string): Promise<boolean>;
  primaryNpcs(worldId: string, contextId: string): Promise<string[]>;
  persist(input: {
    worldId: string;
    contextId: string;
    speakerEntityId: string | null;
    npcIds: string[];
    message: IncomingMessage;
    traceId: string;
  }): Promise<void>;
}

function speaker(mappings: IdentityMapping[]): string | null | false {
  const characters = mappings.filter(
    (mapping) => mapping.mappingType === "player_character",
  );
  const ids = [...new Set(characters.map((mapping) => mapping.entityId))];
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  const primaries = [
    ...new Set(
      characters
        .filter((mapping) => mapping.isPrimary)
        .map((mapping) => mapping.entityId),
    ),
  ];
  return primaries.length === 1 ? primaries[0] : false;
}

export function createDiscordIntake(
  persistence: IntakePersistence,
  diagnose: Diagnostics = () => {},
) {
  return async (input: unknown): Promise<string> => {
    try {
      const parsed = incomingMessageSchema.safeParse(input);
      if (!parsed.success) return "unsupported";
      const message = parsed.data;
      // Mention-only pings have no request body. Replies and roles are not targets.
      if (!message.content.replace(/<@!?\d+>/gu, "").trim())
        return "irrelevant";
      const worlds = [...new Set(await persistence.worldIds(message))];
      if (worlds.length !== 1)
        return worlds.length ? "ambiguous_world" : "unmapped";
      const worldId = worlds[0];
      const context = await persistence.context(worldId, message);
      if (
        !context ||
        context.status !== "active" ||
        context.worldId !== worldId
      )
        return "unmapped";
      const speakerEntityId = speaker(
        await persistence.identities(worldId, message.authorId),
      );
      if (speakerEntityId === false) return "ambiguous_speaker";
      const targets = new Set<string>();
      if (message.mentionedUserIds.length) {
        for (const userId of new Set(message.mentionedUserIds)) {
          const operators = (
            await persistence.identities(worldId, userId)
          ).filter((mapping) => mapping.mappingType === "npc_operator");
          const candidates = [
            ...new Set(operators.map((mapping) => mapping.entityId)),
          ];
          if (candidates.length > 1) return "ambiguous_target";
          if (candidates.length === 1) {
            if (!(await persistence.isNpc(worldId, candidates[0])))
              return "invalid_target";
            targets.add(candidates[0]);
          }
        }
      } else {
        const candidates = [
          ...new Set(await persistence.primaryNpcs(worldId, context.id)),
        ];
        if (candidates.length > 1) return "ambiguous_target";
        if (candidates.length === 1) {
          if (!(await persistence.isNpc(worldId, candidates[0])))
            return "invalid_target";
          targets.add(candidates[0]);
        }
      }
      if (!targets.size) return "untargeted";
      await persistence.persist({
        worldId,
        contextId: context.id,
        speakerEntityId,
        npcIds: [...targets].sort(),
        message,
        traceId: randomUUID(),
      });
      diagnose({
        event: "discord_intake",
        outcome: "accepted",
        targets: targets.size,
      });
      return "accepted";
    } catch {
      diagnose({ event: "discord_intake", outcome: "error" });
      return "error";
    }
  };
}
