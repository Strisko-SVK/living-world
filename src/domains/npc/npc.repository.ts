import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../../db/client.js";
import { entities } from "../../db/schema/entities.js";
import { npcCapabilities } from "../../db/schema/npc-capabilities.js";
import { npcGameProfiles } from "../../db/schema/npc-game-profiles.js";
import { npcState } from "../../db/schema/npc-state.js";
import { npcs } from "../../db/schema/npcs.js";

import {
  createNpcInputSchema,
  npcCapabilityInputSchema,
  npcGameProfileInputSchema,
  updateNpcStateInputSchema,
  type CreateNpcInput,
  type NpcCapabilityInput,
  type NpcGameProfileInput,
  type UpdateNpcStateInput,
} from "./npc.validation.js";

type Database = Omit<DatabaseClient["db"], "$client">;

export class NpcStateVersionConflictError extends Error {
  constructor() {
    super("NPC state version does not match the expected version.");
    this.name = "NpcStateVersionConflictError";
  }
}

export async function createNpc(
  database: Database,
  worldId: string,
  input: CreateNpcInput,
) {
  const value = createNpcInputSchema.parse(input);

  return database.transaction(async (transaction) => {
    if (value.initialState.currentLocationId) {
      await assertEntityInWorld(
        transaction,
        worldId,
        value.initialState.currentLocationId,
      );
    }

    const entityId = randomUUID();
    const [entity] = await transaction
      .insert(entities)
      .values({
        id: entityId,
        worldId,
        entityType: "npc",
        canonicalName: value.canonicalName,
        status: value.entityStatus,
      })
      .returning();

    if (!entity) {
      throw new Error("NPC entity creation did not return a record.");
    }

    const [npc] = await transaction
      .insert(npcs)
      .values({
        entityId,
        simulationDepth: value.simulationDepth,
        narrativeWeight: value.narrativeWeight,
        lifecycleState: value.lifecycleState,
        canonProtected: value.canonProtected,
        templateVersion: value.templateVersion,
        profileVersion: value.profileVersion,
        baselineProfile: value.baselineProfile,
      })
      .returning();

    if (!npc) {
      throw new Error("NPC creation did not return a record.");
    }

    await transaction.insert(npcState).values({
      npcId: entityId,
      ...value.initialState,
      version: 1,
    });

    if (value.gameProfile) {
      await transaction.insert(npcGameProfiles).values({
        npcId: entityId,
        ...value.gameProfile,
        version: 1,
      });
    }

    if (value.capabilities.length > 0) {
      await transaction.insert(npcCapabilities).values(
        value.capabilities.map((capability) => ({
          npcId: entityId,
          ...capability,
        })),
      );
    }

    return { ...entity, ...npc };
  });
}

export async function getNpc(
  database: Database,
  worldId: string,
  npcId: string,
) {
  const [row] = await database
    .select({ entity: entities, npc: npcs })
    .from(npcs)
    .innerJoin(entities, eq(npcs.entityId, entities.id))
    .where(
      and(
        eq(npcs.entityId, npcId),
        eq(entities.worldId, worldId),
        eq(entities.entityType, "npc"),
      ),
    )
    .limit(1);

  return row ? { ...row.entity, ...row.npc } : null;
}

export async function getNpcWithState(
  database: Database,
  worldId: string,
  npcId: string,
) {
  const npc = await getNpc(database, worldId, npcId);

  if (!npc) {
    return null;
  }

  const [state] = await database
    .select()
    .from(npcState)
    .where(eq(npcState.npcId, npcId))
    .limit(1);

  return { npc, state: state ?? null };
}

export async function updateNpcState(
  database: Database,
  worldId: string,
  npcId: string,
  input: UpdateNpcStateInput,
) {
  const value = updateNpcStateInputSchema.parse(input);
  const npc = await getNpc(database, worldId, npcId);

  if (!npc) {
    return null;
  }

  if (value.currentLocationId) {
    await assertEntityInWorld(database, worldId, value.currentLocationId);
  }

  const conditions = [eq(npcState.npcId, npcId)];
  if (value.expectedVersion !== undefined) {
    conditions.push(eq(npcState.version, value.expectedVersion));
  }

  const [state] = await database
    .update(npcState)
    .set({
      ...(value.currentLocationId !== undefined
        ? { currentLocationId: value.currentLocationId }
        : {}),
      ...(value.locationCertainty !== undefined
        ? { locationCertainty: value.locationCertainty }
        : {}),
      ...(value.physicalState !== undefined
        ? { physicalState: value.physicalState }
        : {}),
      ...(value.emotionalState !== undefined
        ? { emotionalState: value.emotionalState }
        : {}),
      ...(value.materialState !== undefined
        ? { materialState: value.materialState }
        : {}),
      ...(value.availabilityState !== undefined
        ? { availabilityState: value.availabilityState }
        : {}),
      version: sql`${npcState.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning();

  if (!state) {
    throw new NpcStateVersionConflictError();
  }

  return state;
}

export async function upsertNpcGameProfile(
  database: Database,
  worldId: string,
  npcId: string,
  input: NpcGameProfileInput,
) {
  const value = npcGameProfileInputSchema.parse(input);
  const npc = await getNpc(database, worldId, npcId);

  if (!npc) {
    return null;
  }

  const [gameProfile] = await database
    .insert(npcGameProfiles)
    .values({ npcId, ...value, version: 1 })
    .onConflictDoUpdate({
      target: npcGameProfiles.npcId,
      set: {
        ...value,
        version: sql`${npcGameProfiles.version} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!gameProfile) {
    throw new Error("NPC game profile upsert did not return a record.");
  }

  return gameProfile;
}

export async function getNpcGameProfile(
  database: Database,
  worldId: string,
  npcId: string,
) {
  const npc = await getNpc(database, worldId, npcId);

  if (!npc) {
    return null;
  }

  const [gameProfile] = await database
    .select()
    .from(npcGameProfiles)
    .where(eq(npcGameProfiles.npcId, npcId))
    .limit(1);

  return gameProfile ?? null;
}

export async function upsertNpcCapability(
  database: Database,
  worldId: string,
  npcId: string,
  input: NpcCapabilityInput,
) {
  const value = npcCapabilityInputSchema.parse(input);
  const npc = await getNpc(database, worldId, npcId);

  if (!npc) {
    return null;
  }

  const [capability] = await database
    .insert(npcCapabilities)
    .values({ npcId, ...value })
    .onConflictDoUpdate({
      target: [npcCapabilities.npcId, npcCapabilities.capabilityKey],
      set: {
        level: value.level,
        source: value.source,
        confidence: value.confidence,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!capability) {
    throw new Error("NPC capability upsert did not return a record.");
  }

  return capability;
}

export async function listNpcCapabilities(
  database: Database,
  worldId: string,
  npcId: string,
) {
  const npc = await getNpc(database, worldId, npcId);

  if (!npc) {
    return [];
  }

  return database
    .select()
    .from(npcCapabilities)
    .where(eq(npcCapabilities.npcId, npcId));
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

  if (!entity) {
    throw new Error("Referenced entity was not found in the specified world.");
  }
}
