import { normalizeAlias } from "../domains/entity/alias-normalizer.js";

// botId is supplied separately by the authenticated adapter, never by message
// content, a display name, a mapping, or a user-controlled envelope field.
export function parseDiscordTrigger(
  content: string,
  botId: string | null | undefined,
  mentionedUserIds: readonly string[],
): { alias: string; body: string } | null {
  if (!botId || !/^\d{1,20}$/u.test(botId) || !mentionedUserIds.includes(botId))
    return null;
  if (content.length > 20_000) return null;
  const match = /^<@!?(\d{1,20})>[ \t]+\[([^[\]\r\n]+)\][ \t]+([\s\S]+)$/u.exec(
    content.trim(),
  );
  if (!match || match[1] !== botId) return null;
  const alias = match[2].trim();
  const body = match[3].trim();
  if (
    !alias ||
    alias.length > 200 ||
    /[\p{Cc}\p{Cf}]/u.test(alias) ||
    !body.replace(/<@!?\d+>/gu, "").trim()
  )
    return null;
  return { alias: normalizeAlias(alias), body };
}
