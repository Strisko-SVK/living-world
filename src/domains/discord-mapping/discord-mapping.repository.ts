import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
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

export class DiscordMappingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordMappingConflictError";
  }
}

// Transaction locks also serialize first assignments, when no identity row exists.
async function lockRouting(database: Database, key: string[]) {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(key)}, 0))`,
  );
}

function mappingError(error: unknown): never {
  const cause = error as { code?: string; cause?: { code?: string } };
  if ((cause.code ?? cause.cause?.code) === "23505") {
    throw new DiscordMappingConflictError(
      "Discord mapping conflicts with an existing location or identity mapping.",
    );
  }
  throw error;
}

export async function mapDiscordUserToEntity(
  database: Database,
  worldId: string,
  input: MapDiscordUserToEntityInput,
) {
  const value = mapDiscordUserToEntityInputSchema.parse(input);
  await assertEntityInWorld(database, worldId, value.entityId);
  return database
    .transaction(async (transaction) => {
      await lockRouting(transaction, [
        "identity",
        worldId,
        value.discordUserId,
      ]);
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
    })
    .catch(mappingError);
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
  return database
    .transaction(async (transaction) => {
      await lockRouting(transaction, [
        "identity",
        worldId,
        value.discordUserId,
      ]);
      const mappings = await transaction
        .select()
        .from(discordIdentities)
        .where(
          and(
            eq(discordIdentities.worldId, worldId),
            eq(discordIdentities.discordUserId, value.discordUserId),
            eq(discordIdentities.entityId, entityId),
            eq(discordIdentities.status, "active"),
          ),
        )
        .limit(2);
      if (mappings.length === 0) {
        const [inactive] = await transaction
          .select({ id: discordIdentities.id })
          .from(discordIdentities)
          .where(
            and(
              eq(discordIdentities.worldId, worldId),
              eq(discordIdentities.discordUserId, value.discordUserId),
              eq(discordIdentities.entityId, entityId),
            ),
          )
          .limit(1);
        if (inactive)
          throw new Error(
            "Inactive Discord identity mappings cannot be primary.",
          );
        return null;
      }
      if (mappings.length > 1)
        throw new DiscordMappingConflictError(
          "Primary entity selection requires an unambiguous identity mapping.",
        );
      const mapping = mappings[0]!;
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
    })
    .catch(mappingError);
}

export async function deactivateDiscordUserMapping(
  database: Database,
  worldId: string,
  mappingId: string,
) {
  return database.transaction(async (transaction) => {
    const [mapping] = await transaction
      .select()
      .from(discordIdentities)
      .where(
        and(
          eq(discordIdentities.id, mappingId),
          eq(discordIdentities.worldId, worldId),
        ),
      )
      .limit(1);
    if (!mapping) return null;
    await lockRouting(transaction, [
      "identity",
      worldId,
      mapping.discordUserId,
    ]);
    const [updated] = await transaction
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
  });
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
    .returning()
    .catch(mappingError);
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
  const mappings = await database
    .select()
    .from(discordContextMappings)
    .where(
      and(
        eq(discordContextMappings.worldId, worldId),
        eq(discordContextMappings.contextId, contextId),
        eq(discordContextMappings.status, "active"),
      ),
    )
    .limit(2);
  if (mappings.length > 1)
    throw new DiscordMappingConflictError(
      "Context has multiple active Discord mappings; primary routing is ambiguous.",
    );
  return mappings[0] ?? null;
}

export async function setNpcPrimaryContext(
  database: Database,
  worldId: string,
  npcId: string,
  contextId: string,
) {
  return database
    .transaction(async (transaction) => {
      await lockRouting(transaction, ["npc", worldId, npcId]);
      const [npc, context] = await Promise.all([
        getNpc(transaction, worldId, npcId),
        getContextInWorld(transaction, worldId, contextId),
      ]);
      if (!npc) return null;
      if (!context)
        throw new Error(
          "Interaction context was not found in the NPC's world.",
        );
      const candidate = await getDiscordMappingForContext(
        transaction,
        worldId,
        contextId,
      );
      if (!candidate)
        throw new Error(
          "Interaction context does not have an active Discord mapping.",
        );
      const [mapping] = await transaction
        .select()
        .from(discordContextMappings)
        .where(eq(discordContextMappings.id, candidate.id))
        .for("update");
      if (!mapping || mapping.status !== "active")
        throw new DiscordMappingConflictError(
          "Discord context mapping changed during primary selection.",
        );
      if (mapping.npcId && mapping.npcId !== npcId)
        throw new Error(
          "Discord context mapping is already primary for another NPC.",
        );
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
    })
    .catch(mappingError);
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
