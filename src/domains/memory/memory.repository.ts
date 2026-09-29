import { and, eq, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../../db/client.js";
import { entities } from "../../db/schema/entities.js";
import { memoryRelations } from "../../db/schema/memory-relations.js";
import { memorySources } from "../../db/schema/memory-sources.js";
import { npcMemories } from "../../db/schema/npc-memories.js";
import { getNpc } from "../npc/npc.repository.js";

import {
  addMemoryRelationInputSchema,
  addMemorySourceInputSchema,
  createMemoryInputSchema,
  listMemoriesFilterSchema,
  updateMemoryStatusInputSchema,
  type AddMemoryRelationInput,
  type AddMemorySourceInput,
  type CreateMemoryInput,
  type ListMemoriesFilters,
  type UpdateMemoryStatusInput,
} from "./memory.validation.js";

type Database = Omit<DatabaseClient["db"], "$client">;

export async function createMemory(
  database: Database,
  worldId: string,
  npcId: string,
  input: CreateMemoryInput,
) {
  const value = createMemoryInputSchema.parse(input);
  const npc = await getNpc(database, worldId, npcId);

  if (!npc) {
    return null;
  }

  const [memory] = await database
    .insert(npcMemories)
    .values({ id: randomUUID(), worldId, npcId, ...value })
    .returning();

  if (!memory) {
    throw new Error("Memory creation did not return a record.");
  }

  return memory;
}

export async function getMemory(
  database: Database,
  worldId: string,
  npcId: string,
  memoryId: string,
) {
  const npc = await getNpc(database, worldId, npcId);

  if (!npc) {
    return null;
  }

  const [memory] = await database
    .select()
    .from(npcMemories)
    .where(
      and(
        eq(npcMemories.id, memoryId),
        eq(npcMemories.worldId, worldId),
        eq(npcMemories.npcId, npcId),
      ),
    )
    .limit(1);

  return memory ?? null;
}

export async function listMemories(
  database: Database,
  worldId: string,
  npcId: string,
  filters?: ListMemoriesFilters,
) {
  const value = listMemoriesFilterSchema.parse(filters ?? {});
  const npc = await getNpc(database, worldId, npcId);

  if (!npc) {
    return [];
  }

  const conditions = [
    eq(npcMemories.worldId, worldId),
    eq(npcMemories.npcId, npcId),
  ];
  if (value.status) conditions.push(eq(npcMemories.status, value.status));
  if (value.memoryType)
    conditions.push(eq(npcMemories.memoryType, value.memoryType));
  if (value.retentionClass)
    conditions.push(eq(npcMemories.retentionClass, value.retentionClass));

  return database
    .select()
    .from(npcMemories)
    .where(and(...conditions));
}

export async function addMemorySource(
  database: Database,
  worldId: string,
  npcId: string,
  memoryId: string,
  input: AddMemorySourceInput,
) {
  const value = addMemorySourceInputSchema.parse(input);
  const memory = await getMemory(database, worldId, npcId, memoryId);

  if (!memory) {
    return null;
  }

  if (value.sourceEntityId) {
    const [sourceEntity] = await database
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.id, value.sourceEntityId),
          eq(entities.worldId, worldId),
        ),
      )
      .limit(1);

    if (!sourceEntity) {
      throw new Error("Source entity was not found in the memory's world.");
    }
  }

  const [source] = await database
    .insert(memorySources)
    .values({ id: randomUUID(), memoryId, ...value })
    .returning();

  if (!source) {
    throw new Error("Memory source creation did not return a record.");
  }

  return source;
}

export async function listMemorySources(
  database: Database,
  worldId: string,
  npcId: string,
  memoryId: string,
) {
  const memory = await getMemory(database, worldId, npcId, memoryId);

  if (!memory) {
    return [];
  }

  return database
    .select()
    .from(memorySources)
    .where(eq(memorySources.memoryId, memoryId));
}

export async function addMemoryRelation(
  database: Database,
  worldId: string,
  npcId: string,
  input: AddMemoryRelationInput,
) {
  const value = addMemoryRelationInputSchema.parse(input);
  const [parent, child] = await Promise.all([
    getMemory(database, worldId, npcId, value.parentMemoryId),
    getMemory(database, worldId, npcId, value.childMemoryId),
  ]);

  if (!parent || !child) {
    return null;
  }

  const [relation] = await database
    .insert(memoryRelations)
    .values(value)
    .returning();

  if (!relation) {
    throw new Error("Memory relation creation did not return a record.");
  }

  return relation;
}

export async function listMemoryRelations(
  database: Database,
  worldId: string,
  npcId: string,
  memoryId: string,
) {
  const memory = await getMemory(database, worldId, npcId, memoryId);

  if (!memory) {
    return [];
  }

  return database
    .select()
    .from(memoryRelations)
    .where(
      or(
        eq(memoryRelations.parentMemoryId, memoryId),
        eq(memoryRelations.childMemoryId, memoryId),
      ),
    );
}

export async function updateMemoryStatus(
  database: Database,
  worldId: string,
  npcId: string,
  memoryId: string,
  input: UpdateMemoryStatusInput,
) {
  const value = updateMemoryStatusInputSchema.parse(input);
  const memory = await getMemory(database, worldId, npcId, memoryId);

  if (!memory) {
    return null;
  }

  const [updatedMemory] = await database
    .update(npcMemories)
    .set({ status: value.status, updatedAt: new Date() })
    .where(eq(npcMemories.id, memoryId))
    .returning();

  return updatedMemory ?? null;
}
