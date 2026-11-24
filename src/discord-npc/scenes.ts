import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  discordCampaigns,
  discordContextMappings,
  discordRpChannels,
  interactionContexts,
  contextIntakePolicyAudit,
  npcState,
  localPresence,
  sceneSpeechPolicies,
} from "../db/schema/index.js";
import { createInteractionContext } from "../domains/interaction/interaction.repository.js";
import {
  lockRouting,
  mapDiscordContext,
} from "../domains/discord-mapping/discord-mapping.repository.js";
import {
  grantLocalPresence,
  revokeLocalPresence,
} from "../communication/local.repository.js";
import {
  issueHostSceneSpeechPolicy,
  revokeHostSceneSpeechPolicy,
} from "../communication/scene-speech-policies.repository.js";
import type {
  Campaign,
  Database,
  NpcRegistry,
  Parent,
  RegisteredNpc,
  SceneRoute,
} from "./registry.js";

export const campaignCategoryApproved = (
  c: Campaign,
  actualCategory: string | null,
) => c.categoryId === null || c.categoryId === actualCategory;

export function createNpcScenes(db: Database, registry: NpcRegistry) {
  async function parent(route: SceneRoute, conn = db) {
    const [row] = await conn
      .select()
      .from(discordRpChannels)
      .where(
        and(
          eq(discordRpChannels.guildId, route.guildId),
          eq(discordRpChannels.channelId, route.channelId),
        ),
      );
    return row ?? null;
  }

  async function configure(
    campaign: Campaign,
    actorId: string,
    route: SceneRoute,
    actualCategory: string | null,
    npc: RegisteredNpc,
    action: "enable" | "reassign" | "disable" | "scene",
  ) {
    if (
      route.guildId !== campaign.guildId ||
      route.threadId ||
      !campaignCategoryApproved(campaign, actualCategory)
    )
      return "unapproved_channel";
    return db.transaction(async (tx) => {
      await lockRouting(tx, ["native-guild", route.guildId]);
      const actor = await registry.member(campaign.worldId, actorId, tx);
      if (!actor || actor.role === "player") return "forbidden";
      const current = await parent(route, tx);
      if (action === "disable") {
        if (
          current?.worldId !== campaign.worldId ||
          current.baseNpcId !== npc.npcId
        )
          return "unregistered_channel";
        if (!current.active) return "already_disabled";
        await lockRouting(tx, ["location", route.guildId, route.channelId]);
        await tx
          .update(discordRpChannels)
          .set({ active: false })
          .where(whereParent(route));
        return "disabled";
      }
      const baseNpcId = action === "scene" ? null : npc.npcId;
      if (
        current &&
        (current.worldId !== campaign.worldId ||
          current.baseNpcId !== baseNpcId ||
          current.locationId !== npc.home_id)
      )
        return "channel_conflict";
      if (current?.active) return "already_enabled";
      const [previous] = baseNpcId
        ? await tx
            .select()
            .from(discordRpChannels)
            .where(
              and(
                eq(discordRpChannels.worldId, campaign.worldId),
                eq(discordRpChannels.baseNpcId, baseNpcId),
                eq(discordRpChannels.active, true),
              ),
            )
        : [];
      if (previous && action !== "reassign") return "base_conflict";
      for (const id of [
        ...new Set([
          route.channelId,
          ...(previous ? [previous.channelId] : []),
        ]),
      ].sort())
        await lockRouting(tx, ["location", route.guildId, id]);
      const foreign = await tx
        .select()
        .from(discordContextMappings)
        .where(
          and(
            eq(discordContextMappings.guildId, route.guildId),
            eq(discordContextMappings.channelId, route.channelId),
          ),
        );
      if (
        foreign.some((row) => row.worldId !== campaign.worldId) ||
        (!current && foreign.length)
      )
        return "channel_conflict";
      if (previous)
        await tx
          .update(discordRpChannels)
          .set({ active: false })
          .where(whereParent(previous));
      if (current)
        await tx
          .update(discordRpChannels)
          .set({ active: true, enabledAt: sql`clock_timestamp()` })
          .where(whereParent(route));
      else
        await tx.insert(discordRpChannels).values({
          guildId: route.guildId,
          channelId: route.channelId,
          worldId: campaign.worldId,
          baseNpcId,
          locationId: npc.home_id,
        });
      return previous ? "reassigned" : "enabled";
    });
  }

  async function discover(approved: Parent, route: SceneRoute) {
    if (
      approved.guildId !== route.guildId ||
      approved.channelId !== route.channelId
    )
      return null;
    return db.transaction(async (tx) => {
      await lockRouting(tx, ["location", route.guildId, route.channelId]);
      const current = await parent(route, tx);
      if (
        !current?.active ||
        current.worldId !== approved.worldId ||
        current.enabledAt.getTime() !== approved.enabledAt.getTime()
      )
        return null;
      const [campaign] = await tx
        .select()
        .from(discordCampaigns)
        .where(
          and(
            eq(discordCampaigns.guildId, route.guildId),
            eq(discordCampaigns.active, true),
          ),
        );
      if (campaign?.worldId !== current.worldId) return null;
      const relevant = await tx
        .select()
        .from(discordContextMappings)
        .where(
          and(
            eq(discordContextMappings.guildId, route.guildId),
            eq(discordContextMappings.channelId, route.channelId),
            route.threadId
              ? eq(discordContextMappings.threadId, route.threadId)
              : isNull(discordContextMappings.threadId),
          ),
        );
      if (relevant.length) {
        const [mapping] = relevant;
        if (
          relevant.length !== 1 ||
          mapping.worldId !== current.worldId ||
          mapping.status !== "active" ||
          mapping.mappingType !== "scene" ||
          mapping.npcId !== null
        )
          return null;
        return {
          worldId: current.worldId,
          contextId: mapping.contextId,
          mappingId: mapping.id,
          locationId: current.locationId,
        };
      }
      const scene = await createInteractionContext(tx, current.worldId, {
        contextType: "scene",
        externalProvider: "discord",
        externalGuildId: route.guildId,
        externalChannelId: route.channelId,
        externalThreadId: route.threadId,
        linkedLocationEntityId: current.locationId,
      });
      const mapping = await mapDiscordContext(tx, current.worldId, {
        contextId: scene.id,
        ...route,
        mappingType: "scene",
      });
      await tx
        .update(interactionContexts)
        .set({ npcIntakePolicy: "mapped_players" })
        .where(eq(interactionContexts.id, scene.id));
      await tx.insert(contextIntakePolicyAudit).values({
        id: randomUUID(),
        worldId: current.worldId,
        contextId: scene.id,
        previousPolicy: "disabled",
        targetPolicy: "mapped_players",
      });
      return {
        worldId: current.worldId,
        contextId: scene.id,
        mappingId: mapping.id,
        locationId: current.locationId,
      };
    });
  }

  async function deleted(route: SceneRoute) {
    await db.transaction(async (tx) => {
      await lockRouting(tx, ["native-guild", route.guildId]);
      await lockRouting(tx, ["location", route.guildId, route.channelId]);
      const current = await parent(route, tx);
      if (!current) return;
      if (!route.threadId) {
        await tx
          .update(discordRpChannels)
          .set({ active: false })
          .where(whereParent(route));
        return;
      }
      const [mapping] = await tx
        .update(discordContextMappings)
        .set({ status: "inactive" })
        .where(
          and(
            eq(discordContextMappings.worldId, current.worldId),
            eq(discordContextMappings.guildId, route.guildId),
            eq(discordContextMappings.channelId, route.channelId),
            eq(discordContextMappings.threadId, route.threadId),
          ),
        )
        .returning();
      if (mapping)
        await tx
          .update(interactionContexts)
          .set({ status: "archived", npcIntakePolicy: "disabled" })
          .where(eq(interactionContexts.id, mapping.contextId));
    });
  }

  async function recordWebhook(route: SceneRoute, webhookId: string) {
    await db
      .update(discordRpChannels)
      .set({ webhookId })
      .where(and(whereParent(route), eq(discordRpChannels.active, true)));
  }

  async function sourceAllowed(
    approved: Parent,
    route: SceneRoute & { authorId: string },
    actor: string,
    sourceMs: number,
    issuer: string,
  ) {
    const result = await db.execute(sql`
      select 1 from discord_rp_channels parent
      join discord_campaigns campaign on campaign.guild_id=parent.guild_id and campaign.world_id=parent.world_id
      join discord_campaign_members member on member.world_id=parent.world_id and member.discord_user_id=${route.authorId}
      join discord_identities identity on identity.world_id=member.world_id and identity.entity_id=member.entity_id
        and identity.discord_user_id=member.discord_user_id
      join discord_campaign_members owner on owner.world_id=campaign.world_id and owner.discord_user_id=campaign.owner_user_id
      where parent.guild_id=${route.guildId} and parent.channel_id=${route.channelId}
        and parent.world_id=${approved.worldId} and parent.active and campaign.active
        and parent.base_npc_id is not distinct from ${approved.baseNpcId}::uuid
        and parent.location_id=${approved.locationId}
        and parent.enabled_at <= to_timestamp(${sourceMs}::double precision / 1000)
        and member.entity_id=${actor} and member.active and owner.active and owner.role='admin' and owner.entity_id=${issuer}
        and identity.status='active' and identity.mapping_type='player_character'
        and member.authorized_at <= to_timestamp(${sourceMs}::double precision / 1000)
      limit 2
    `);
    return result.rows.length === 1;
  }

  async function visibleBases(
    worldId: string,
    userId: string,
    inspect: (route: SceneRoute, userId: string) => Promise<unknown>,
  ) {
    const visible = [];
    for (const base of (await registry.parents(worldId))
      .filter((row) => row.active && row.baseNpcId)
      .slice(0, 30)) {
      if (await inspect({ ...base, threadId: null }, userId))
        visible.push(base);
    }
    return visible;
  }
  return {
    parent,
    configure,
    discover,
    deleted,
    recordWebhook,
    visibleBases,
    sourceAllowed,
  };
}

const whereParent = (route: Pick<SceneRoute, "guildId" | "channelId">) =>
  and(
    eq(discordRpChannels.guildId, route.guildId),
    eq(discordRpChannels.channelId, route.channelId),
  );

export async function ensureSceneSpeech(
  db: Database,
  scene: { worldId: string; contextId: string; locationId: string },
  npcId: string,
  issuerEntityId: string,
) {
  const scope = { worldId: scene.worldId, contextId: scene.contextId, npcId };
  return db.transaction(async (tx) => {
    await lockRouting(tx, ["native-scene-speech", scope.contextId, npcId]);
    const [state] = await tx
      .select()
      .from(npcState)
      .where(eq(npcState.npcId, npcId))
      .for("share");
    if (
      !state ||
      state.locationCertainty !== "certain" ||
      state.currentLocationId !== scene.locationId ||
      (state.availabilityState.status !== undefined &&
        state.availabilityState.status !== "available")
    )
      return null;
    const [policy] = await tx
      .select()
      .from(sceneSpeechPolicies)
      .where(
        and(
          eq(sceneSpeechPolicies.worldId, scope.worldId),
          eq(sceneSpeechPolicies.contextId, scope.contextId),
          eq(sceneSpeechPolicies.npcId, npcId),
          isNull(sceneSpeechPolicies.revokedAt),
        ),
      )
      .limit(1);
    // Only a runtime-owned allow from this campaign can be reused or retired.
    if (
      policy &&
      (!policy.discordNativeManaged ||
        policy.decision !== "allow_direct_speech" ||
        policy.issuerEntityId !== issuerEntityId ||
        !(
          await tx.execute(
            sql`select 1 from npc_scene_speech_policies where id=${policy.id} and issued_by=current_user`,
          )
        ).rows.length)
    )
      return null;
    if (!policy) {
      const [prior] = await tx
        .select()
        .from(sceneSpeechPolicies)
        .where(
          and(
            eq(sceneSpeechPolicies.worldId, scope.worldId),
            eq(sceneSpeechPolicies.contextId, scope.contextId),
            eq(sceneSpeechPolicies.npcId, npcId),
          ),
        )
        .orderBy(sql`${sceneSpeechPolicies.issuedAt} desc`)
        .limit(1);
      if (
        prior?.discordNativeManaged &&
        prior.revokedAt &&
        prior.npcStateVersion === state.version &&
        prior.expiresAt.getTime() > Date.now()
      )
        return null;
    }
    const presence = await tx
      .select()
      .from(localPresence)
      .where(
        and(
          eq(localPresence.worldId, scope.worldId),
          eq(localPresence.contextId, scope.contextId),
          eq(localPresence.npcId, npcId),
        ),
      )
      .orderBy(sql`${localPresence.issuedAt} desc`)
      .limit(1);
    let evidence = presence[0];
    // A revoked presence on the current state version is an explicit stop.
    if (evidence?.revokedAt && evidence.stateVersion === state.version)
      return null;
    if (
      policy &&
      (policy.npcStateVersion !== state.version ||
        !evidence ||
        policy.presenceId !== evidence.id ||
        policy.expiresAt.getTime() <= Date.now() + 125_000)
    ) {
      const revoked = await revokeHostSceneSpeechPolicy(
        tx,
        { ...scope, presenceId: policy.presenceId },
        policy.id,
      );
      if (revoked.status !== "revoked") return null;
    } else if (policy) {
      return { policyId: policy.id, presenceId: policy.presenceId };
    }
    if (
      evidence &&
      !evidence.revokedAt &&
      evidence.stateVersion !== state.version
    ) {
      const revoked = await revokeLocalPresence(tx, scope, evidence.id);
      if (revoked.status !== "revoked") return null;
    }
    if (
      !evidence ||
      evidence.revokedAt ||
      evidence.stateVersion !== state.version
    ) {
      const result = await grantLocalPresence(tx, scope);
      if (result.status !== "granted") return null;
      evidence = result.evidence;
    }
    const issued = await issueHostSceneSpeechPolicy(tx, {
      ...scope,
      presenceId: evidence.id,
      issuerEntityId,
      ttlMinutes: 30,
      discordNativeManaged: true,
      decision: "allow_direct_speech",
      activity: "free",
      perception: "aware",
      otherScene: "none",
    });
    if (issued.status !== "created") return null;
    return { policyId: issued.id, presenceId: evidence.id };
  });
}
