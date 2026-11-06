import { ChannelType, MessageType, type Message } from "discord.js";
import {
  incomingMessageSchema,
  type IncomingMessage,
} from "../../intake/discord-intake.js";

const supportedChannels = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

// Fixed-vocabulary, privacy-safe reasons only. Do not emit field values,
// payloads, author IDs, tokens, or Zod's raw errors at the adapter boundary.
export type DiscordNormalizationRejection =
  | "message_shape_rejected"
  | "thread_parent_missing"
  | "content_unavailable"
  | "mentions_unavailable"
  | "source_message_id_invalid"
  | "author_id_invalid"
  | "guild_id_invalid"
  | "channel_id_invalid"
  | "thread_id_invalid"
  | "content_invalid"
  | "mention_ids_invalid"
  | "schema_invalid";

export type DiscordNormalizationDiagnostic = (
  reason: DiscordNormalizationRejection,
) => void;

function schemaRejection(field: string | number | undefined): DiscordNormalizationRejection {
  switch (field) {
    case "sourceMessageId":
      return "source_message_id_invalid";
    case "authorId":
      return "author_id_invalid";
    case "guildId":
      return "guild_id_invalid";
    case "channelId":
      return "channel_id_invalid";
    case "threadId":
      return "thread_id_invalid";
    case "content":
      return "content_invalid";
    case "mentionedUserIds":
      return "mention_ids_invalid";
    default:
      return "schema_invalid";
  }
}

export function normalizeDiscordMessage(
  message: Message,
  diagnose?: DiscordNormalizationDiagnostic,
): IncomingMessage | null {
  const reject = (reason: DiscordNormalizationRejection): null => {
    diagnose?.(reason);
    return null;
  };
  if (
    message.partial ||
    message.author.bot ||
    message.webhookId ||
    message.system ||
    !message.guildId ||
    !supportedChannels.has(message.channel.type) ||
    (message.type !== MessageType.Default && message.type !== MessageType.Reply)
  )
    return reject("message_shape_rejected");
  const isThread = message.channel.isThread();
  const parentId = isThread ? message.channel.parentId : null;
  if (isThread && !parentId) return reject("thread_parent_missing");
  if (typeof message.content !== "string" || !message.content.trim())
    return reject("content_unavailable");
  if (!message.mentions?.users || typeof message.mentions.users.has !== "function")
    return reject("mentions_unavailable");

  // SDK mention collections may include a replied-to author. Require a literal
  // mention in this message as well, never treating reply metadata as a target.
  const literalMentions = [...message.content.matchAll(/<@!?(\d+)>/gu)].map(
    (match) => match[1],
  );
  const parsed = incomingMessageSchema.safeParse({
    sourceMessageId: message.id,
    authorId: message.author.id,
    guildId: message.guildId,
    channelId: isThread ? parentId : message.channelId,
    threadId: isThread ? message.channelId : null,
    content: message.content,
    mentionedUserIds: [
      ...new Set(
        literalMentions.filter((id) => message.mentions.users.has(id)),
      ),
    ],
  });
  if (!parsed.success)
    return reject(schemaRejection(parsed.error.issues[0]?.path[0]));
  return parsed.data;
}
