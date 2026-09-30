import { and, asc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../../db/client.js";
import { entities } from "../../db/schema/entities.js";
import { interactionContexts } from "../../db/schema/interaction-contexts.js";
import { interactions } from "../../db/schema/interactions.js";
import { getNpc } from "../npc/npc.repository.js";

import {
  createInteractionContextInputSchema,
  createInteractionInputSchema,
  failInteractionInputSchema,
  findInteractionContextByExternalRefInputSchema,
  listInteractionsFilterSchema,
  recordInteractionResponseInputSchema,
  type CreateInteractionContextInput,
  type CreateInteractionInput,
  type ListInteractionsFilters,
  type RecordInteractionResponseInput,
} from "./interaction.validation.js";

type Database = Omit<DatabaseClient["db"], "$client">;
type InteractionStatus =
  "received" | "processing" | "responded" | "completed" | "failed";

const allowedTransitions: Record<
  InteractionStatus,
  readonly InteractionStatus[]
> = {
  received: ["processing", "responded", "failed"],
  processing: ["responded", "failed"],
  responded: ["completed"],
  completed: [],
  failed: [],
};

export function assertInteractionTransition(
  current: InteractionStatus,
  next: InteractionStatus,
) {
  if (!allowedTransitions[current].includes(next)) {
    throw new Error(
      `Interaction cannot transition from ${current} to ${next}.`,
    );
  }
}

export async function createInteractionContext(
  database: Database,
  worldId: string,
  input: CreateInteractionContextInput,
) {
  const value = createInteractionContextInputSchema.parse(input);
  if (value.linkedLocationEntityId) {
    await assertEntityInWorld(
      database,
      worldId,
      value.linkedLocationEntityId,
      "Linked location entity",
    );
  }
  const [context] = await database
    .insert(interactionContexts)
    .values({ id: randomUUID(), worldId, ...value })
    .returning();
  if (!context)
    throw new Error("Interaction context creation did not return a record.");
  return context;
}

export async function getInteractionContext(
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

export async function findInteractionContextByExternalRef(
  database: Database,
  worldId: string,
  provider: string,
  guildId?: string | null,
  channelId?: string | null,
  threadId?: string | null,
) {
  const value = findInteractionContextByExternalRefInputSchema.parse({
    provider,
    guildId,
    channelId,
    threadId,
  });
  const [context] = await database
    .select()
    .from(interactionContexts)
    .where(
      and(
        eq(interactionContexts.worldId, worldId),
        eq(interactionContexts.externalProvider, value.provider),
        value.guildId
          ? eq(interactionContexts.externalGuildId, value.guildId)
          : isNull(interactionContexts.externalGuildId),
        value.channelId
          ? eq(interactionContexts.externalChannelId, value.channelId)
          : isNull(interactionContexts.externalChannelId),
        value.threadId
          ? eq(interactionContexts.externalThreadId, value.threadId)
          : isNull(interactionContexts.externalThreadId),
      ),
    )
    .limit(1);
  return context ?? null;
}

export async function createInteraction(
  database: Database,
  worldId: string,
  npcId: string,
  input: CreateInteractionInput,
) {
  const value = createInteractionInputSchema.parse(input);
  const [npc, context] = await Promise.all([
    getNpc(database, worldId, npcId),
    getInteractionContext(database, worldId, value.contextId),
  ]);
  if (!npc) return null;
  if (!context)
    throw new Error(
      "Interaction context was not found in the interaction's world.",
    );
  if (value.speakerEntityId) {
    await assertEntityInWorld(
      database,
      worldId,
      value.speakerEntityId,
      "Speaker entity",
    );
  }
  const [interaction] = await database
    .insert(interactions)
    .values({
      id: randomUUID(),
      worldId,
      npcId,
      ...value,
      traceId: value.traceId ?? randomUUID(),
      status: "received",
    })
    .returning();
  if (!interaction)
    throw new Error("Interaction creation did not return a record.");
  return interaction;
}

export async function getInteraction(
  database: Database,
  worldId: string,
  npcId: string,
  interactionId: string,
) {
  const npc = await getNpc(database, worldId, npcId);
  if (!npc) return null;
  const [interaction] = await database
    .select()
    .from(interactions)
    .where(
      and(
        eq(interactions.id, interactionId),
        eq(interactions.worldId, worldId),
        eq(interactions.npcId, npcId),
      ),
    )
    .limit(1);
  return interaction ?? null;
}

export async function listInteractionsForNpc(
  database: Database,
  worldId: string,
  npcId: string,
  filters?: ListInteractionsFilters,
) {
  const value = listInteractionsFilterSchema.parse(filters ?? {});
  const npc = await getNpc(database, worldId, npcId);
  if (!npc) return [];
  const conditions = [
    eq(interactions.worldId, worldId),
    eq(interactions.npcId, npcId),
  ];
  if (value.contextId)
    conditions.push(eq(interactions.contextId, value.contextId));
  if (value.status) conditions.push(eq(interactions.status, value.status));
  if (value.interactionType)
    conditions.push(eq(interactions.interactionType, value.interactionType));
  if (value.traceId) conditions.push(eq(interactions.traceId, value.traceId));
  return database
    .select()
    .from(interactions)
    .where(and(...conditions))
    .orderBy(asc(interactions.createdAt), asc(interactions.id));
}

export async function markInteractionProcessing(
  database: Database,
  worldId: string,
  npcId: string,
  interactionId: string,
) {
  return transitionInteraction(
    database,
    worldId,
    npcId,
    interactionId,
    "processing",
  );
}

export async function recordInteractionResponse(
  database: Database,
  worldId: string,
  npcId: string,
  interactionId: string,
  input: RecordInteractionResponseInput,
) {
  const value = recordInteractionResponseInputSchema.parse(input);
  const interaction = await getInteraction(
    database,
    worldId,
    npcId,
    interactionId,
  );
  if (!interaction) return null;
  if (interaction.responseText !== null)
    throw new Error("Interaction response has already been recorded.");
  assertInteractionTransition(interaction.status, "responded");
  const [updated] = await database
    .update(interactions)
    .set({ ...value, status: "responded", respondedAt: new Date() })
    .where(
      and(
        eq(interactions.id, interactionId),
        eq(interactions.status, interaction.status),
      ),
    )
    .returning();
  if (!updated)
    throw new Error(
      "Interaction state changed before its response was recorded.",
    );
  return updated;
}

export async function completeInteraction(
  database: Database,
  worldId: string,
  npcId: string,
  interactionId: string,
) {
  return transitionInteraction(
    database,
    worldId,
    npcId,
    interactionId,
    "completed",
    { completedAt: new Date() },
  );
}

export async function failInteraction(
  database: Database,
  worldId: string,
  npcId: string,
  interactionId: string,
  reason?: string,
) {
  failInteractionInputSchema.parse({ reason });
  return transitionInteraction(
    database,
    worldId,
    npcId,
    interactionId,
    "failed",
  );
}

async function transitionInteraction(
  database: Database,
  worldId: string,
  npcId: string,
  interactionId: string,
  nextStatus: InteractionStatus,
  values: Partial<typeof interactions.$inferInsert> = {},
) {
  const interaction = await getInteraction(
    database,
    worldId,
    npcId,
    interactionId,
  );
  if (!interaction) return null;
  assertInteractionTransition(interaction.status, nextStatus);
  const [updated] = await database
    .update(interactions)
    .set({ ...values, status: nextStatus })
    .where(
      and(
        eq(interactions.id, interactionId),
        eq(interactions.status, interaction.status),
      ),
    )
    .returning();
  if (!updated)
    throw new Error(
      "Interaction state changed before transition could be applied.",
    );
  return updated;
}

async function assertEntityInWorld(
  database: Database,
  worldId: string,
  entityId: string,
  label: string,
) {
  const [entity] = await database
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.id, entityId), eq(entities.worldId, worldId)))
    .limit(1);
  if (!entity)
    throw new Error(`${label} was not found in the interaction's world.`);
}
