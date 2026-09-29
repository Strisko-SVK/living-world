import { and, asc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../../db/client.js";
import { entities } from "../../db/schema/entities.js";
import { npcKnowledge } from "../../db/schema/npc-knowledge.js";
import { npcMemories } from "../../db/schema/npc-memories.js";
import { relationshipEvents } from "../../db/schema/relationship-events.js";
import { relationships } from "../../db/schema/relationships.js";

import {
  applyRelationshipEventInputSchema,
  createRelationshipInputSchema,
  relationshipDimensionKeys,
  relationshipEndpointsSchema,
  updateRelationshipIntentSchema,
  type ApplyRelationshipEventInput,
  type CreateRelationshipInput,
  type RelationshipIntentInput,
} from "./relationship.validation.js";

type Database = Omit<DatabaseClient["db"], "$client">;

export class RelationshipVersionConflictError extends Error {
  constructor() {
    super("Relationship version does not match the expected version.");
    this.name = "RelationshipVersionConflictError";
  }
}

export async function createRelationship(
  database: Database,
  worldId: string,
  sourceEntityId: string,
  targetEntityId: string,
  input?: CreateRelationshipInput,
) {
  const endpoints = relationshipEndpointsSchema.parse({
    sourceEntityId,
    targetEntityId,
  });
  const value = createRelationshipInputSchema.parse(input ?? {});
  await assertEntitiesInWorld(database, worldId, [
    endpoints.sourceEntityId,
    endpoints.targetEntityId,
  ]);

  const [relationship] = await database
    .insert(relationships)
    .values({ id: randomUUID(), worldId, ...endpoints, ...value })
    .returning();
  if (!relationship)
    throw new Error("Relationship creation did not return a record.");

  return relationship;
}

export async function getRelationship(
  database: Database,
  worldId: string,
  sourceEntityId: string,
  targetEntityId: string,
) {
  const [relationship] = await database
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.worldId, worldId),
        eq(relationships.sourceEntityId, sourceEntityId),
        eq(relationships.targetEntityId, targetEntityId),
      ),
    )
    .limit(1);
  return relationship ?? null;
}

export async function listRelationshipsFrom(
  database: Database,
  worldId: string,
  sourceEntityId: string,
) {
  const source = await getEntityInWorld(database, worldId, sourceEntityId);
  if (!source) return [];

  return database
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.worldId, worldId),
        eq(relationships.sourceEntityId, sourceEntityId),
      ),
    );
}

export async function listRelationshipsTo(
  database: Database,
  worldId: string,
  targetEntityId: string,
) {
  const target = await getEntityInWorld(database, worldId, targetEntityId);
  if (!target) return [];

  return database
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.worldId, worldId),
        eq(relationships.targetEntityId, targetEntityId),
      ),
    );
}

export async function applyRelationshipEvent(
  database: Database,
  worldId: string,
  sourceEntityId: string,
  targetEntityId: string,
  input: ApplyRelationshipEventInput,
) {
  const value = applyRelationshipEventInputSchema.parse(input);

  return database.transaction(async (transaction) => {
    const relationship = await getRelationship(
      transaction,
      worldId,
      sourceEntityId,
      targetEntityId,
    );
    if (!relationship) return null;

    if (
      value.expectedVersion !== undefined &&
      relationship.version !== value.expectedVersion
    ) {
      throw new RelationshipVersionConflictError();
    }

    await assertEventProvenance(transaction, relationship, value);
    const nextDimensions = Object.fromEntries(
      relationshipDimensionKeys.map((key) => [
        key,
        relationship[key] + (value.delta[key] ?? 0),
      ]),
    ) as Record<(typeof relationshipDimensionKeys)[number], number>;
    for (const [dimension, nextValue] of Object.entries(nextDimensions)) {
      if (nextValue < 0 || nextValue > 100) {
        throw new Error(
          `Relationship ${dimension} would be outside the 0..100 range.`,
        );
      }
    }

    const [updatedRelationship] = await transaction
      .update(relationships)
      .set({
        ...nextDimensions,
        version: sql`${relationships.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(relationships.id, relationship.id),
          eq(relationships.version, relationship.version),
        ),
      )
      .returning();
    if (!updatedRelationship) throw new RelationshipVersionConflictError();

    const [event] = await transaction
      .insert(relationshipEvents)
      .values({
        id: randomUUID(),
        relationshipId: relationship.id,
        eventType: value.eventType,
        delta: value.delta,
        reasonSummary: value.reasonSummary,
        sourceInteractionId: value.sourceInteractionId,
        sourceMemoryId: value.sourceMemoryId,
        sourceKnowledgeId: value.sourceKnowledgeId,
        occurredAt: value.occurredAt,
      })
      .returning();
    if (!event)
      throw new Error("Relationship event creation did not return a record.");

    return { relationship: updatedRelationship, event };
  });
}

export async function listRelationshipEvents(
  database: Database,
  worldId: string,
  sourceEntityId: string,
  targetEntityId: string,
) {
  const relationship = await getRelationship(
    database,
    worldId,
    sourceEntityId,
    targetEntityId,
  );
  if (!relationship) return [];

  return database
    .select()
    .from(relationshipEvents)
    .where(eq(relationshipEvents.relationshipId, relationship.id))
    .orderBy(asc(relationshipEvents.createdAt), asc(relationshipEvents.id));
}

export async function updateRelationshipIntent(
  database: Database,
  worldId: string,
  sourceEntityId: string,
  targetEntityId: string,
  intent: RelationshipIntentInput,
) {
  const value = updateRelationshipIntentSchema.parse(intent);
  const relationship = await getRelationship(
    database,
    worldId,
    sourceEntityId,
    targetEntityId,
  );
  if (!relationship) return null;

  const [updatedRelationship] = await database
    .update(relationships)
    .set({
      intent: value,
      version: sql`${relationships.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(relationships.id, relationship.id))
    .returning();
  return updatedRelationship ?? null;
}

async function assertEntitiesInWorld(
  database: Database,
  worldId: string,
  entityIds: string[],
) {
  for (const entityId of entityIds) {
    const entity = await getEntityInWorld(database, worldId, entityId);
    if (!entity) {
      throw new Error(
        "Referenced entity was not found in the relationship's world.",
      );
    }
  }
}

async function getEntityInWorld(
  database: Database,
  worldId: string,
  entityId: string,
) {
  const [entity] = await database
    .select({ id: entities.id, entityType: entities.entityType })
    .from(entities)
    .where(and(eq(entities.id, entityId), eq(entities.worldId, worldId)))
    .limit(1);
  return entity ?? null;
}

async function assertEventProvenance(
  database: Database,
  relationship: typeof relationships.$inferSelect,
  input: ApplyRelationshipEventInput,
) {
  if (!input.sourceMemoryId && !input.sourceKnowledgeId) return;
  const sourceEntity = await getEntityInWorld(
    database,
    relationship.worldId,
    relationship.sourceEntityId,
  );
  if (!sourceEntity) {
    throw new Error("Relationship source entity was not found in its world.");
  }

  if (input.sourceMemoryId) {
    const [memory] = await database
      .select({ id: npcMemories.id, npcId: npcMemories.npcId })
      .from(npcMemories)
      .where(
        and(
          eq(npcMemories.id, input.sourceMemoryId),
          eq(npcMemories.worldId, relationship.worldId),
        ),
      )
      .limit(1);
    if (
      !memory ||
      (sourceEntity.entityType === "npc" &&
        memory.npcId !== relationship.sourceEntityId)
    ) {
      throw new Error("Source memory is not available for this relationship.");
    }
  }

  if (input.sourceKnowledgeId) {
    const [knowledge] = await database
      .select({ id: npcKnowledge.id, npcId: npcKnowledge.npcId })
      .from(npcKnowledge)
      .where(
        and(
          eq(npcKnowledge.id, input.sourceKnowledgeId),
          eq(npcKnowledge.worldId, relationship.worldId),
        ),
      )
      .limit(1);
    if (
      !knowledge ||
      (sourceEntity.entityType === "npc" &&
        knowledge.npcId !== relationship.sourceEntityId)
    ) {
      throw new Error(
        "Source knowledge is not available for this relationship.",
      );
    }
  }
}
