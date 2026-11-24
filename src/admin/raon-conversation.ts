import { and, eq, sql } from "drizzle-orm";
import { selectM219History } from "../response/dialogue-context.js";
import type { DatabaseClient } from "../db/client.js";
import { discordConversations } from "../db/schema/discord-conversations.js";
import type { IncomingMessage } from "../intake/discord-intake.js";
import { parseDiscordTrigger } from "../intake/discord-trigger.js";
import { discordMessageCreatedAt } from "../intake/discord-snowflake.js";
import { normalizeAlias } from "../domains/entity/alias-normalizer.js";

type Database = Omit<DatabaseClient["db"], "$client">;
type Scene = {
  worldId: string;
  contextId: string;
  mappingId: string;
  playerEntityId: string;
};
export type ConversationNpc = { npcId: string; aliases: readonly string[] };
export const playerText = (text: string) =>
  text.replace(/<(?:@!?[0-9]+|@&[0-9]+|#[0-9]+)>/gu, "[Discord mention]");

export function createRaonConversation(
  db: Database,
  scene: Scene,
  inactivityMs: number,
  options?: {
    defaultNpcId: string | null;
    explicitOnly: boolean;
    experimentalHistory?: boolean;
  },
) {
  const { worldId, contextId, mappingId, playerEntityId } = scene;
  const scope = { worldId, contextId, playerEntityId };
  const where = and(
    eq(discordConversations.worldId, worldId),
    eq(discordConversations.contextId, contextId),
    eq(discordConversations.playerEntityId, playerEntityId),
  );

  async function select(
    message: IncomingMessage,
    botId: string,
    npcs: readonly ConversationNpc[],
  ) {
    const content = message.content.trim();
    if (/^(?:\/\/|\(\(|\[ooc\]|ooc\s*:)/iu.test(content))
      return { kind: "out_of_character" } as const;
    const [prior] = await db.select().from(discordConversations).where(where);
    if (prior && BigInt(prior.lastSourceId) >= BigInt(message.sourceMessageId))
      return { kind: "old_source" } as const;
    if (/^\/end-npc$/iu.test(content)) return { kind: "closed" } as const;
    const explicit = parseDiscordTrigger(
      content,
      botId,
      message.mentionedUserIds,
    );
    if (explicit) return named(explicit.alias, explicit.body, true);
    // Literal mentions and explicit addresses to someone else never fall
    // through to the active NPC. Reply metadata takes precedence over names.
    if (/<(?:@!?\d+|@&\d+|#\d+)>/u.test(content))
      return { kind: "other_address" } as const;
    if (message.replyToMessageId) {
      const rows = await delivered({ replyId: message.replyToMessageId });
      if (rows.length === 1 && typeof rows[0].npc_id === "string")
        return target(rows[0].npc_id, content, "reply");
      return { kind: "other_reply" } as const;
    }
    const bracketed = /^\[([^[\]\r\n]+)\]\s+([\s\S]+)$/u.exec(content);
    if (bracketed)
      return named(normalizeAlias(bracketed[1]), bracketed[2], false);
    const addressed = /^([\p{L}][\p{L}\p{N} .'-]{0,42})[:,]\s+([\s\S]+)$/u.exec(
      content,
    );
    if (addressed) {
      const alias = normalizeAlias(addressed[1]);
      if (npcs.some((npc) => npc.aliases.includes(alias)))
        return named(alias, addressed[2], false);
      if (addressed[0].includes(":")) return { kind: "other_address" } as const;
    }
    if (options?.explicitOnly) return { kind: "inactive" } as const;
    if (!prior && options?.defaultNpcId)
      return target(options.defaultNpcId, content, "default");
    const last = prior && discordMessageCreatedAt(prior.lastSourceId);
    const current = discordMessageCreatedAt(message.sourceMessageId);
    if (!prior?.npcId || !last || !current || current - last >= inactivityMs)
      return { kind: "inactive" } as const;
    return target(prior.npcId, content, "follow_up");

    function named(alias: string, request: string, mentioned: boolean) {
      const matches = npcs.filter((npc) => npc.aliases.includes(alias));
      if (matches.length !== 1)
        return { kind: "ambiguous_or_unknown" } as const;
      return {
        kind: "selected",
        npcId: matches[0].npcId,
        alias,
        request,
        mentioned,
        via: "name",
      } as const;
    }

    function target(
      npcId: string,
      request: string,
      via: "reply" | "follow_up" | "default",
    ) {
      if (!npcs.some((npc) => npc.npcId === npcId))
        return { kind: "unavailable" } as const;
      return {
        kind: "selected",
        npcId,
        alias: undefined,
        request,
        mentioned: false,
        via,
      } as const;
    }
  }

  async function focus(message: IncomingMessage, npcId: string | null) {
    // Store the original source snowflake so duplicate/late messages cannot
    // reopen a closed focus or take focus away from a newer NPC.
    await db
      .insert(discordConversations)
      .values({
        ...scope,
        npcId,
        lastSourceId: message.sourceMessageId,
      })
      .onConflictDoUpdate({
        target: [
          discordConversations.worldId,
          discordConversations.contextId,
          discordConversations.playerEntityId,
        ],
        set: { npcId, lastSourceId: message.sourceMessageId },
        setWhere: sql`${discordConversations.lastSourceId}::numeric < ${message.sourceMessageId}::numeric`,
      });
  }

  async function delivered(query: { npcId: string } | { replyId: string }) {
    const filter =
      "replyId" in query
        ? sql`d.ack_message_id=${query.replyId}`
        : sql`i.npc_id=${query.npcId}`;
    const result = await db.execute(sql`
      select i.npc_id, i.request_text, i.response_text
      from npc_response_deliveries d
      join interactions i on i.id=d.interaction_id and i.world_id=d.world_id
        and i.context_id=d.context_id and i.npc_id=d.npc_id
      where i.world_id=${worldId} and i.context_id=${contextId}
        and i.source_mapping_id=${mappingId} and i.source_provider='discord'
        and i.speaker_entity_id=${playerEntityId} and i.status in ('responded','completed')
        and d.status='delivered' and d.ack_message_id=i.response_message_id and ${filter}
      order by d.delivered_at desc, d.id desc
      limit ${"replyId" in query ? 2 : 36}
    `);
    return result.rows;
  }

  async function history(npcId: string, request: string, botId: string) {
    const rows = await delivered({ npcId });
    const pairs = rows.flatMap(({ request_text, response_text }) => {
      if (typeof request_text !== "string" || typeof response_text !== "string")
        return [];
      const body =
        parseDiscordTrigger(request_text, botId, [botId])?.body ?? request_text;
      return [{ player: playerText(body), speech: response_text }];
    });
    return options?.experimentalHistory
      ? selectM219History(pairs, request)
      : selectRaonHistory(pairs, request);
  }

  return { select, focus, history };
}

const terms = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .match(/[\p{L}\p{N}]{4,}/gu) ?? [],
  );

export function selectRaonHistory(
  pairs: { player: string; speech: string }[],
  request: string,
) {
  const requestTerms = terms(request);
  const excerpts = pairs
    .slice(5)
    .map((pair, index) => ({
      pair,
      index,
      score: [...terms(pair.player + " " + pair.speech)].filter((word) =>
        requestTerms.has(word),
      ).length,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => b.index - a.index)
    .map(({ pair }) => ({
      player: pair.player.slice(0, 100),
      speech: pair.speech.slice(0, 130),
    }));
  return {
    recent: pairs
      .slice(0, 5)
      .reverse()
      .map((pair) => ({
        player: pair.player.slice(0, 220),
        speech: pair.speech.slice(0, 300),
      })),
    excerpts,
  };
}
