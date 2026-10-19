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

export function normalizeDiscordMessage(
  message: Message,
): IncomingMessage | null {
  if (
    message.partial ||
    message.author.bot ||
    message.webhookId ||
    message.system ||
    !message.guildId ||
    !supportedChannels.has(message.channel.type) ||
    (message.type !== MessageType.Default && message.type !== MessageType.Reply)
  )
    return null;
  const isThread = message.channel.isThread();
  const parentId = isThread ? message.channel.parentId : null;
  if (isThread && !parentId) return null;
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
  return parsed.success ? parsed.data : null;
}
