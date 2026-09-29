import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../../db/client.js";
import { entities } from "../../db/schema/entities.js";
import { knowledgeConflicts } from "../../db/schema/knowledge-conflicts.js";
import { knowledgeSources } from "../../db/schema/knowledge-sources.js";
import { npcKnowledge } from "../../db/schema/npc-knowledge.js";
import { npcMemories } from "../../db/schema/npc-memories.js";
import { getNpc } from "../npc/npc.repository.js";

import {
  addKnowledgeSourceInputSchema,
  createKnowledgeConflictInputSchema,
  createKnowledgeInputSchema,
  listKnowledgeConflictsFilterSchema,
  listKnowledgeFilterSchema,
  updateKnowledgeConfidenceInputSchema,
  updateKnowledgeStatusInputSchema,
  type AddKnowledgeSourceInput,
  type CreateKnowledgeInput,
  type ListKnowledgeConflictsFilters,
  type ListKnowledgeFilters,
  type UpdateKnowledgeConfidenceInput,
  type UpdateKnowledgeStatusInput,
} from "./knowledge.validation.js";

type Database = Omit<DatabaseClient["db"], "$client">;

export async function createKnowledge(
  database: Database,
  worldId: string,
  npcId: string,
  input: CreateKnowledgeInput,
) {
  const value = createKnowledgeInputSchema.parse(input);
  const npc = await getNpc(database, worldId, npcId);
  if (!npc) return null;

  await assertEntitiesInWorld(database, worldId, [
    value.subjectEntityId,
    value.objectEntityId,
  ]);

  const [knowledge] = await database
    .insert(npcKnowledge)
    .values({ id: randomUUID(), worldId, npcId, ...value })
    .returning();
  if (!knowledge)
    throw new Error("Knowledge creation did not return a record.");

  return knowledge;
}

export async function getKnowledge(
  database: Database,
  worldId: string,
  npcId: string,
  knowledgeId: string,
) {
  const npc = await getNpc(database, worldId, npcId);
  if (!npc) return null;

  const [knowledge] = await database
    .select()
    .from(npcKnowledge)
    .where(
      and(
        eq(npcKnowledge.id, knowledgeId),
        eq(npcKnowledge.worldId, worldId),
        eq(npcKnowledge.npcId, npcId),
      ),
    )
    .limit(1);
  return knowledge ?? null;
}

export async function listKnowledge(
  database: Database,
  worldId: string,
  npcId: string,
  filters?: ListKnowledgeFilters,
) {
  const value = listKnowledgeFilterSchema.parse(filters ?? {});
  const npc = await getNpc(database, worldId, npcId);
  if (!npc) return [];

  const conditions = [
    eq(npcKnowledge.worldId, worldId),
    eq(npcKnowledge.npcId, npcId),
  ];
  if (value.classification)
    conditions.push(eq(npcKnowledge.classification, value.classification));
  if (value.status) conditions.push(eq(npcKnowledge.status, value.status));
  if (value.secrecy) conditions.push(eq(npcKnowledge.secrecy, value.secrecy));
  if (value.subjectEntityId)
    conditions.push(eq(npcKnowledge.subjectEntityId, value.subjectEntityId));

  return database
    .select()
    .from(npcKnowledge)
    .where(and(...conditions));
}

export async function addKnowledgeSource(
  database: Database,
  worldId: string,
  npcId: string,
  knowledgeId: string,
  input: AddKnowledgeSourceInput,
) {
  const value = addKnowledgeSourceInputSchema.parse(input);
  const knowledge = await getKnowledge(database, worldId, npcId, knowledgeId);
  if (!knowledge) return null;

  await assertEntitiesInWorld(database, worldId, [value.sourceEntityId]);

  if (value.sourceKnowledgeId) {
    const [sourceKnowledge] = await database
      .select({ id: npcKnowledge.id })
      .from(npcKnowledge)
      .where(
        and(
          eq(npcKnowledge.id, value.sourceKnowledgeId),
          eq(npcKnowledge.worldId, worldId),
        ),
      )
      .limit(1);
    if (!sourceKnowledge) {
      throw new Error(
        "Source knowledge was not found in the knowledge's world.",
      );
    }
  }

  if (value.sourceMemoryId) {
    const [sourceMemory] = await database
      .select({ id: npcMemories.id })
      .from(npcMemories)
      .where(
        and(
          eq(npcMemories.id, value.sourceMemoryId),
          eq(npcMemories.worldId, worldId),
          eq(npcMemories.npcId, npcId),
        ),
      )
      .limit(1);
    if (!sourceMemory) {
      throw new Error("Source memory was not found for the knowledge's NPC.");
    }
  }

  const [source] = await database
    .insert(knowledgeSources)
    .values({ id: randomUUID(), knowledgeId, ...value })
    .returning();
  if (!source)
    throw new Error("Knowledge source creation did not return a record.");

  return source;
}

export async function listKnowledgeSources(
  database: Database,
  worldId: string,
  npcId: string,
  knowledgeId: string,
) {
  const knowledge = await getKnowledge(database, worldId, npcId, knowledgeId);
  if (!knowledge) return [];

  return database
    .select()
    .from(knowledgeSources)
    .where(eq(knowledgeSources.knowledgeId, knowledgeId));
}

export async function createKnowledgeConflict(
  database: Database,
  worldId: string,
  npcId: string,
  claimAId: string,
  claimBId: string,
) {
  const value = createKnowledgeConflictInputSchema.parse({
    claimAId,
    claimBId,
  });
  const [claimA, claimB] = await Promise.all([
    getKnowledge(database, worldId, npcId, value.claimAId),
    getKnowledge(database, worldId, npcId, value.claimBId),
  ]);
  if (!claimA || !claimB) return null;

  const [canonicalClaimAId, canonicalClaimBId] = [
    value.claimAId,
    value.claimBId,
  ].sort();
  const [conflict] = await database
    .insert(knowledgeConflicts)
    .values({
      id: randomUUID(),
      worldId,
      npcId,
      claimAId: canonicalClaimAId!,
      claimBId: canonicalClaimBId!,
    })
    .returning();
  if (!conflict)
    throw new Error("Knowledge conflict creation did not return a record.");

  return conflict;
}

export async function listKnowledgeConflicts(
  database: Database,
  worldId: string,
  npcId: string,
  filters?: ListKnowledgeConflictsFilters,
) {
  const value = listKnowledgeConflictsFilterSchema.parse(filters ?? {});
  const npc = await getNpc(database, worldId, npcId);
  if (!npc) return [];

  const conditions = [
    eq(knowledgeConflicts.worldId, worldId),
    eq(knowledgeConflicts.npcId, npcId),
  ];
  if (value.status)
    conditions.push(eq(knowledgeConflicts.status, value.status));
  return database
    .select()
    .from(knowledgeConflicts)
    .where(and(...conditions));
}

export async function updateKnowledgeStatus(
  database: Database,
  worldId: string,
  npcId: string,
  knowledgeId: string,
  input: UpdateKnowledgeStatusInput,
) {
  const value = updateKnowledgeStatusInputSchema.parse(input);
  const knowledge = await getKnowledge(database, worldId, npcId, knowledgeId);
  if (!knowledge) return null;

  const [updatedKnowledge] = await database
    .update(npcKnowledge)
    .set({ status: value.status, updatedAt: new Date() })
    .where(eq(npcKnowledge.id, knowledgeId))
    .returning();
  return updatedKnowledge ?? null;
}

export async function updateKnowledgeConfidence(
  database: Database,
  worldId: string,
  npcId: string,
  knowledgeId: string,
  input: UpdateKnowledgeConfidenceInput,
) {
  const value = updateKnowledgeConfidenceInputSchema.parse(input);
  const knowledge = await getKnowledge(database, worldId, npcId, knowledgeId);
  if (!knowledge) return null;

  const [updatedKnowledge] = await database
    .update(npcKnowledge)
    .set({ confidence: value.confidence, updatedAt: new Date() })
    .where(eq(npcKnowledge.id, knowledgeId))
    .returning();
  return updatedKnowledge ?? null;
}

async function assertEntitiesInWorld(
  database: Database,
  worldId: string,
  entityIds: Array<string | null | undefined>,
) {
  for (const entityId of entityIds) {
    if (!entityId) continue;
    const [entity] = await database
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, entityId), eq(entities.worldId, worldId)))
      .limit(1);
    if (!entity) {
      throw new Error(
        "Referenced entity was not found in the knowledge's world.",
      );
    }
  }
}
