import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import {
  discordCampaigns,
  discordCampaignMembers,
  discordNpcRegistry,
  discordRpChannels,
} from "../db/schema/index.js";
import { createWorld } from "../domains/world/world.repository.js";
import { createEntity } from "../domains/entity/entity.repository.js";
import {
  lockRouting,
  mapDiscordUserToEntity,
} from "../domains/discord-mapping/discord-mapping.repository.js";
import { normalizeAlias } from "../domains/entity/alias-normalizer.js";
import { seedQuartermaster } from "../admin/quartermaster-profile.js";
import { seedSentinel } from "../admin/raon-dev-fixture.js";

export type Database = Omit<DatabaseClient["db"], "$client">;
export type Campaign = typeof discordCampaigns.$inferSelect;
export type Parent = typeof discordRpChannels.$inferSelect;
export type SceneRoute = {
  guildId: string;
  channelId: string;
  threadId: string | null;
};
export type MemberRole = "admin" | "dm" | "player";
export const nativeWorldPrefix = "lw-dev-discord-";
export const snowflake = /^[1-9][0-9]{16,19}$/u;

// The approved DEV catalog instantiates each template once in the campaign.
// Adding a template here changes onboarding data, not Discord routing.
const templates = [
  {
    key: "quartermaster",
    home: "Supply Office, Cargo Deck",
    create: seedQuartermaster,
  },
  {
    key: "sentinel",
    home: "Observation Post A",
    create: async (db: Database, worldId: string, home: string) =>
      (await seedSentinel(db, worldId, home, true, "Observation Post A"))
        .entityId,
  },
];

export function createNpcRegistry(db: Database, approvedGuildId: string) {
  if (!snowflake.test(approvedGuildId))
    throw new Error("Invalid approved Discord guild.");

  async function campaign(guildId: string) {
    if (guildId !== approvedGuildId) return null;
    const [row] = await db
      .select()
      .from(discordCampaigns)
      .where(
        and(
          eq(discordCampaigns.guildId, guildId),
          eq(discordCampaigns.active, true),
        ),
      );
    return row ?? null;
  }

  async function bootstrap(
    guildId: string,
    verifiedOwnerId: string,
    categoryId: string | null,
  ) {
    if (
      guildId !== approvedGuildId ||
      !snowflake.test(verifiedOwnerId) ||
      (categoryId !== null && !snowflake.test(categoryId))
    )
      return "unapproved";
    return db.transaction(async (tx) => {
      await lockRouting(tx, ["native-guild", guildId]);
      const [existing] = await tx
        .select()
        .from(discordCampaigns)
        .where(eq(discordCampaigns.guildId, guildId));
      if (existing)
        return existing.active &&
          existing.ownerUserId === verifiedOwnerId &&
          existing.categoryId === categoryId
          ? "already_registered"
          : "campaign_conflict";
      const world = await createWorld(tx, {
        key: nativeWorldPrefix + guildId,
        name: "Living World Discord DEV",
        systemType: "test",
        status: "active",
      });
      await tx.insert(discordCampaigns).values({
        guildId,
        worldId: world.id,
        ownerUserId: verifiedOwnerId,
        categoryId,
      });
      await addMember(tx, world.id, verifiedOwnerId, "admin");
      await installTemplates(tx, world.id);
      return "registered";
    });
  }

  async function installTemplates(tx: Database, worldId: string) {
    const prior = await tx
      .select({ key: discordNpcRegistry.templateKey })
      .from(discordNpcRegistry)
      .where(eq(discordNpcRegistry.worldId, worldId));
    const keys = new Set(prior.map((entry) => entry.key));
    for (const template of templates) {
      if (keys.has(template.key)) continue;
      const location = await createEntity(tx, worldId, {
        entityType: "location",
        canonicalName: template.home,
      });
      const npcId = await template.create(tx, worldId, location.id);
      await tx.insert(discordNpcRegistry).values({
        worldId,
        npcId,
        templateKey: template.key,
        homeLocationId: location.id,
      });
    }
  }

  async function member(worldId: string, userId: string, conn = db) {
    const result = await conn.execute<{
      entity_id: string;
      role: MemberRole;
    }>(sql`
      select m.entity_id, m.role from discord_campaign_members m
      join entities e on e.world_id=m.world_id and e.id=m.entity_id
      join discord_identities i on i.world_id=m.world_id and i.entity_id=m.entity_id and i.discord_user_id=m.discord_user_id
      join discord_campaigns dc on dc.world_id=m.world_id and dc.active
      join worlds w on w.id=m.world_id and w.status='active' and w.system_type='test'
      where m.world_id=${worldId} and dc.guild_id=${approvedGuildId} and m.discord_user_id=${userId}
        and m.active and e.status='active' and e.entity_type='player_character'
        and i.status='active' and i.mapping_type='player_character'
      limit 2
    `);
    return result.rows.length === 1 ? result.rows[0] : null;
  }

  async function addMember(
    tx: Database,
    worldId: string,
    userId: string,
    role: MemberRole,
  ) {
    await lockRouting(tx, ["identity", worldId, userId]);
    const [old] = await tx
      .select()
      .from(discordCampaignMembers)
      .where(
        and(
          eq(discordCampaignMembers.worldId, worldId),
          eq(discordCampaignMembers.discordUserId, userId),
        ),
      );
    if (old) {
      await tx
        .update(discordCampaignMembers)
        .set({
          role,
          active: true,
          authorizedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(discordCampaignMembers.worldId, worldId),
            eq(discordCampaignMembers.discordUserId, userId),
          ),
        );
      return;
    }
    const actor = await createEntity(tx, worldId, {
      entityType: "player_character",
      canonicalName: "Discord participant " + randomUUID().slice(0, 8),
    });
    await mapDiscordUserToEntity(tx, worldId, {
      discordUserId: userId,
      entityId: actor.id,
      mappingType: "player_character",
    });
    await tx
      .insert(discordCampaignMembers)
      .values({ worldId, entityId: actor.id, discordUserId: userId, role });
  }

  async function grant(
    c: Campaign,
    adminId: string,
    userId: string,
    role: "dm" | "player" | "remove",
  ) {
    if (
      !snowflake.test(userId) ||
      userId === c.ownerUserId ||
      c.guildId !== approvedGuildId
    )
      return false;
    return db.transaction(async (tx) => {
      await lockRouting(tx, ["native-guild", c.guildId]);
      if ((await member(c.worldId, adminId, tx))?.role !== "admin")
        return false;
      if (role === "remove") {
        await tx
          .update(discordCampaignMembers)
          .set({ active: false, authorizedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(discordCampaignMembers.worldId, c.worldId),
              eq(discordCampaignMembers.discordUserId, userId),
            ),
          );
      } else {
        await addMember(tx, c.worldId, userId, role);
      }
      return true;
    });
  }

  async function roster(worldId: string) {
    const result = await db.execute<{
      npc_id: string;
      name: string;
      template: string;
      home: string;
      home_id: string;
      aliases: string[];
      location: string | null;
      availability: string;
      lifecycle: string;
    }>(sql`
      select r.npc_id,e.canonical_name as name,r.template_key as template,h.canonical_name as home,
        r.home_location_id as home_id,location.canonical_name as location,n.lifecycle_state::text as lifecycle,
        coalesce(s.availability_state->>'status','available') as availability,
        coalesce((select array_agg(a.normalized_alias order by a.normalized_alias) from entity_aliases a
          where a.entity_id=r.npc_id),array[]::text[]) as aliases
      from discord_npc_registry r
      join entities e on e.world_id=r.world_id and e.id=r.npc_id and e.status='active'
      join npcs n on n.entity_id=r.npc_id join npc_state s on s.npc_id=r.npc_id
      join entities h on h.world_id=r.world_id and h.id=r.home_location_id
      left join entities location on location.world_id=r.world_id and location.id=s.current_location_id
      where r.world_id=${worldId}
      order by e.canonical_name limit 100
    `);
    return result.rows.map((row) => ({
      ...row,
      npcId: row.npc_id,
      aliases: [...new Set([...row.aliases, normalizeAlias(row.name)])],
    }));
  }

  async function install(c: Campaign, userId: string) {
    return db.transaction(async (tx) => {
      await lockRouting(tx, ["native-guild", c.guildId]);
      if ((await member(c.worldId, userId, tx))?.role !== "admin") return false;
      await installTemplates(tx, c.worldId);
      return true;
    });
  }

  async function parents(worldId: string) {
    return db
      .select()
      .from(discordRpChannels)
      .where(eq(discordRpChannels.worldId, worldId));
  }

  return { campaign, bootstrap, member, grant, roster, parents, install };
}
export type NpcRegistry = ReturnType<typeof createNpcRegistry>;
export type RegisteredNpc = Awaited<ReturnType<NpcRegistry["roster"]>>[number];
