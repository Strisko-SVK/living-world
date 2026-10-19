import type { DatabaseClient } from "../db/client.js";
import { getWorldById } from "../domains/world/world.repository.js";
import { getEntity } from "../domains/entity/entity.repository.js";
import {
  getNpcWithState,
  getNpcGameProfile,
  listNpcCapabilities,
} from "../domains/npc/npc.repository.js";
import {
  getInteraction,
  getInteractionContext,
  listInteractionsForNpc,
} from "../domains/interaction/interaction.repository.js";
import {
  listKnowledge,
  listKnowledgeSources,
  listKnowledgeConflicts,
} from "../domains/knowledge/knowledge.repository.js";
import {
  listMemories,
  listMemorySources,
} from "../domains/memory/memory.repository.js";
import { listRelationshipsFrom } from "../domains/relationship/relationship.repository.js";
import type { ContextReader, ContextRequest } from "./context.types.js";
import { createContextBuilder } from "./context-builder.js";

type Database = Omit<DatabaseClient["db"], "$client">;
export function createContextReader(database: Database): ContextReader {
  return {
    world: (world) => getWorldById(database, world),
    npc: (world, npc) => getNpcWithState(database, world, npc),
    gameProfile: (world, npc) => getNpcGameProfile(database, world, npc),
    capabilities: (world, npc) => listNpcCapabilities(database, world, npc),
    entity: (world, entity) => getEntity(database, world, entity),
    interaction: (world, npc, id) => getInteraction(database, world, npc, id),
    context: (world, id) => getInteractionContext(database, world, id),
    history: (world, npc, contextId) =>
      listInteractionsForNpc(database, world, npc, { contextId }),
    knowledge: (world, npc) => listKnowledge(database, world, npc),
    knowledgeSources: (world, npc, id) =>
      listKnowledgeSources(database, world, npc, id),
    conflicts: (world, npc) => listKnowledgeConflicts(database, world, npc),
    memories: (world, npc) => listMemories(database, world, npc),
    memorySources: (world, npc, id) =>
      listMemorySources(database, world, npc, id),
    relationships: (world, npc) => listRelationshipsFrom(database, world, npc),
  };
}

export function createNpcContextBuilder(database: Database) {
  return (request: ContextRequest) =>
    database.transaction(
      (transaction) =>
        createContextBuilder(createContextReader(transaction))(request),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
}
