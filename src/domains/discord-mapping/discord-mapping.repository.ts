import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../../db/client.js";
import { discordContextMappings } from "../../db/schema/discord-context-mappings.js";
import { discordIdentities } from "../../db/schema/discord-identities.js";
import { entities } from "../../db/schema/entities.js";
import { interactionContexts } from "../../db/schema/interaction-contexts.js";
import { getNpc } from "../npc/npc.repository.js";

import {
  discordLocationInputSchema,
  listDiscordUserMappingsInputSchema,
  mapDiscordContextInputSchema,
  mapDiscordUserToEntityInputSchema,
  type MapDiscordContextInput,
  type MapDiscordUserToEntityInput,
} from "./discord-mapping.validation.js";

type Database = Omit<DatabaseClient["db"], "$client">;

export async function mapDiscordUserToEntity(
  database: Database,
  worldId: string,
  input: MapDiscordUserToEntityInput,
) {
  const value = mapDiscordUserToEntityInputSchema.parse(input);
  await assertEntityInWorld(database, worldId, value.entityId);
  return database.transaction(async (transaction) => {
    if (value.isPrimary) {
      await transaction
        .update(discordIdentities)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(
          and(
            eq(discordIdentities.worldId, worldId),
            eq(discordIdentities.discordUserId, value.discordUserId),
          ),
        );
    }
    const [mapping] = await transaction
      .insert(discordIdentities)
      .values({ id: randomUUID(), worldId, ...value })
      .returning();
    if (!mapping)
      throw new Error(
        "Discord identity mapping creation did not return a record.",
      );
    return mapping;
  });
}

export async function listDiscordUserMappings(
  database: Database,
  worldId: string,
  discordUserId: string,
  status?: "active" | "inactive",
) {
  const value = listDiscordUserMappingsInputSchema.parse({
    discordUserId,
    status,
  });
  const conditions = [
    eq(discordIdentities.worldId, worldId),
    eq(discordIdentities.discordUserId, value.discordUserId),
  ];
  if (value.status) conditions.push(eq(discordIdentities.status, value.status));
  return database
    .select()
    .from(discordIdentities)
    .where(and(...conditions))
    .orderBy(
      desc(discordIdentities.isPrimary),
      asc(discordIdentities.createdAt),
    );
}

export async function resolveDiscordUserEntities(
  database: Database,
  worldId: string,
  discordUserId: string,
) {
  const mappings = await listDiscordUserMappings(
    database,
    worldId,
    discordUserId,
    "active",
  );
  if (mappings.length === 0) return [];
  const entityIds = mappings.map((mapping) => mapping.entityId);
  const rows = await database
    .select()
    .from(entities)
    .where(eq(entities.worldId, worldId));
  return entityIds.flatMap((entityId) =>
    rows.filter((entity) => entity.id === entityId),
  );
}

export async function setPrimaryDiscordEntity(
  database: Database,
  worldId: string,
  discordUserId: string,
  entityId: string,
) {
  const value = listDiscordUserMappingsInputSchema.parse({ discordUserId });
  await assertEntityInWorld(database, worldId, entityId);
  return database.transaction(async (transaction) => {
    const [mapping] = await transaction
      .select()
      .from(discordIdentities)
      .where(
        and(
          eq(discordIdentities.worldId, worldId),
          eq(discordIdentities.discordUserId, value.discordUserId),
          eq(discordIdentities.entityId, entityId),
        ),
      )
      .limit(1);
    if (!mapping) return null;
    await transaction
      .update(discordIdentities)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(
          eq(discordIdentities.worldId, worldId),
          eq(discordIdentities.discordUserId, value.discordUserId),
        ),
      );
    const [updated] = await transaction
      .update(discordIdentities)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(eq(discordIdentities.id, mapping.id))
      .returning();
    return updated ?? null;
  });
}

export async function deactivateDiscordUserMapping(
  database: Database,
  worldId: string,
  mappingId: string,
) {
  const [updated] = await database
    .update(discordIdentities)
    .set({ status: "inactive", isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(discordIdentities.id, mappingId),
        eq(discordIdentities.worldId, worldId),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function mapDiscordContext(
  database: Database,
  worldId: string,
  input: MapDiscordContextInput,
) {
  const value = mapDiscordContextInputSchema.parse(input);
  const context = await getContextInWorld(database, worldId, value.contextId);
  if (!context)
    throw new Error(
      "Interaction context was not found in the Discord mapping's world.",
    );
  const [mapping] = await database
    .insert(discordContextMappings)
    .values({ id: randomUUID(), worldId, ...value })
    .returning();
  if (!mapping)
    throw new Error(
      "Discord context mapping creation did not return a record.",
    );
  return mapping;
}

export async function getContextByDiscordLocation(
  database: Database,
  worldId: string,
  guildId: string,
  channelId: string,
  threadId?: string | null,
) {
  const value = discordLocationInputSchema.parse({
    guildId,
    channelId,
    threadId,
  });
  const baseConditions = [
    eq(discordContextMappings.worldId, worldId),
    eq(discordContextMappings.guildId, value.guildId),
    eq(discordContextMappings.channelId, value.channelId),
    eq(discordContextMappings.status, "active"),
  ];
  const [threadMapping] = value.threadId
    ? await database
        .select()
        .from(discordContextMappings)
        .where(
          and(
            ...baseConditions,
            eq(discordContextMappings.threadId, value.threadId),
          ),
        )
        .limit(1)
    : [];
  const mapping =
    threadMapping ??
    (
      await database
        .select()
        .from(discordContextMappings)
        .where(and(...baseConditions, isNull(discordContextMappings.threadId)))
        .limit(1)
    )[0];
  if (!mapping) return null;
  return getContextInWorld(database, worldId, mapping.contextId);
}

export async function getDiscordMappingForContext(
  database: Database,
  worldId: string,
  contextId: string,
) {
  const context = await getContextInWorld(database, worldId, contextId);
  if (!context) return null;
  const [mapping] = await database
    .select()
    .from(discordContextMappings)
    .where(
      and(
        eq(discordContextMappings.worldId, worldId),
        eq(discordContextMappings.contextId, contextId),
        eq(discordContextMappings.status, "active"),
      ),
    )
    .orderBy(asc(discordContextMappings.createdAt))
    .limit(1);
  return mapping ?? null;
}

export async function setNpcPrimaryContext(
  database: Database,
  worldId: string,
  npcId: string,
  contextId: string,
) {
  const [npc, context, mapping] = await Promise.all([
    getNpc(database, worldId, npcId),
    getContextInWorld(database, worldId, contextId),
    getDiscordMappingForContext(database, worldId, contextId),
  ]);
  if (!npc) return null;
  if (!context)
    throw new Error("Interaction context was not found in the NPC's world.");
  if (!mapping)
    throw new Error(
      "Interaction context does not have an active Discord mapping.",
    );
  if (mapping.npcId && mapping.npcId !== npcId)
    throw new Error(
      "Discord context mapping is already primary for another NPC.",
    );
  return database.transaction(async (transaction) => {
    await transaction
      .update(discordContextMappings)
      .set({ status: "inactive", updatedAt: new Date() })
      .where(
        and(
          eq(discordContextMappings.worldId, worldId),
          eq(discordContextMappings.npcId, npcId),
          eq(discordContextMappings.status, "active"),
        ),
      );
    const [updated] = await transaction
      .update(discordContextMappings)
      .set({
        npcId,
        mappingType: "npc_primary",
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(discordContextMappings.id, mapping.id))
      .returning();
    if (!updated)
      throw new Error(
        "NPC primary Discord context update did not return a record.",
      );
    return updated;
  });
}

export async function getNpcPrimaryContext(
  database: Database,
  worldId: string,
  npcId: string,
) {
  const npc = await getNpc(database, worldId, npcId);
  if (!npc) return null;
  const [mapping] = await database
    .select()
    .from(discordContextMappings)
    .where(
      and(
        eq(discordContextMappings.worldId, worldId),
        eq(discordContextMappings.npcId, npcId),
        eq(discordContextMappings.mappingType, "npc_primary"),
        eq(discordContextMappings.status, "active"),
      ),
    )
    .limit(1);
  if (!mapping) return null;
  return getContextInWorld(database, worldId, mapping.contextId);
}

async function assertEntityInWorld(
  database: Database,
  worldId: string,
  entityId: string,
) {
  const [entity] = await database
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.id, entityId), eq(entities.worldId, worldId)))
    .limit(1);
  if (!entity)
    throw new Error(
      "Mapped entity was not found in the Discord mapping's world.",
    );
}

async function getContextInWorld(
  database: Database,
  worldId: string,
  contextId: string,
) {
  const [context] = await database
    .select()
    .from(interactionContexts)
    .where(
      and(
        eq(interactionContexts.id, contextId),
        eq(interactionContexts.worldId, worldId),
      ),
    )
    .limit(1);
  return context ?? null;
}
