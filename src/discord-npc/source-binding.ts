import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import type { Interaction } from "../context/context.types.js";

// Route and membership must already have been authorized when Discord
// created the message. A lazy scene can only add evidence tied to its receipt.
export async function nativeSourceCurrent(
  db: Omit<DatabaseClient["db"], "$client">,
  row: Interaction,
  sourceMs: number,
) {
  if (!row.discordNativeSource || !row.speakerEntityId || !row.sourceMappingId)
    return false;
  const result = await db.execute(sql`
    select 1 from discord_rp_channels parent
    join discord_campaigns campaign on campaign.guild_id=parent.guild_id and campaign.world_id=parent.world_id
    join discord_context_mappings route on route.world_id=parent.world_id
      and route.guild_id=parent.guild_id and route.channel_id=parent.channel_id
    join discord_campaign_members member on member.world_id=parent.world_id
    join discord_identities identity on identity.world_id=member.world_id and identity.entity_id=member.entity_id
      and identity.discord_user_id=member.discord_user_id
    where parent.world_id=${row.worldId} and parent.guild_id=${row.sourceGuildId}
      and parent.channel_id=${row.sourceChannelId} and parent.active and campaign.active
      and route.id=${row.sourceMappingId} and route.context_id=${row.contextId}
      and route.thread_id is not distinct from ${row.sourceThreadId}::text
      and route.status='active' and route.mapping_type='scene'
      and member.entity_id=${row.speakerEntityId} and member.active
      and identity.status='active' and identity.mapping_type='player_character'
      and parent.enabled_at <= to_timestamp(${sourceMs}::double precision / 1000)
      and member.authorized_at <= to_timestamp(${sourceMs}::double precision / 1000)
    limit 2
  `);
  return result.rows.length === 1;
}
