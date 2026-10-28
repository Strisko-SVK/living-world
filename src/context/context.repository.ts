import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { entities } from "../db/schema/entities.js";
import { interactions } from "../db/schema/interactions.js";
import { npcKnowledge } from "../db/schema/npc-knowledge.js";
import { npcMemories } from "../db/schema/npc-memories.js";
import { knowledgeSources } from "../db/schema/knowledge-sources.js";
import { memorySources } from "../db/schema/memory-sources.js";
import { knowledgeConflicts } from "../db/schema/knowledge-conflicts.js";
import { relationships } from "../db/schema/relationships.js";
import { npcCapabilities } from "../db/schema/npc-capabilities.js";
import { getWorldById } from "../domains/world/world.repository.js";
import { getEntity } from "../domains/entity/entity.repository.js";
import {
  getNpcWithState,
  getNpcGameProfile,
} from "../domains/npc/npc.repository.js";
import {
  getInteraction,
  getInteractionContext,
} from "../domains/interaction/interaction.repository.js";
import type {
  ContextReader,
  ContextRequest,
  Entity,
  Interaction,
  KnowledgeSource,
  MemorySource,
} from "./context.types.js";
import {
  ContextUnavailableError,
  createContextBuilder,
} from "./context-builder.js";

type Database = Omit<DatabaseClient["db"], "$client">;
// Bounds candidate rows independently of the caller's output/byte limits. A
// knowledge closure exceeding this cap fails closed instead of splitting groups.
export const CONTEXT_CANDIDATE_CAP = 500;
const termsMatch = (column: SQL, terms: string[]) =>
  or(...terms.map((term) => sql`position(${term} in lower(${column})) > 0`)) ??
  sql`false`;
const among = (column: SQL, ids: string[]) =>
  ids.length
    ? sql`${column} in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`,`,
      )})`
    : sql`false`;

// One reader per build/transaction. Caches never outlive its database snapshot.
export function createContextReader(database: Database): ContextReader {
  const sourceTotals = new Map<string, number>();
  const memoryRelevance = new Map<
    string,
    { scene: boolean; participant: boolean }
  >();
  const entityCache = new Map<string, Entity | null>();
  const interactionCache = new Map<string, Interaction | null>();
  let claimIds: string[] = [],
    memoryIds: string[] = [];
  let knowledgeScope: string | undefined, memoryScope: string | undefined;
  let knowledgeBatch: Map<string, KnowledgeSource[]> | undefined;
  let knowledgeBatchLimit: number | undefined,
    memoryBatchLimit: number | undefined;
  let memoryBatch: Map<string, MemorySource[]> | undefined;
  const warmEntities = async (world: string, ids: Array<string | null>) => {
    const needed = [...new Set(ids.filter((id): id is string => !!id))].filter(
      (id) => !entityCache.has(`${world}:${id}`),
    );
    if (!needed.length) return;
    for (const id of needed) entityCache.set(`${world}:${id}`, null);
    // Keep parameter counts bounded even at maximum source/candidate limits.
    for (let offset = 0; offset < needed.length; offset += 1000) {
      for (const row of await database
        .select()
        .from(entities)
        .where(
          and(
            eq(entities.worldId, world),
            inArray(entities.id, needed.slice(offset, offset + 1000)),
          ),
        ))
        entityCache.set(`${world}:${row.id}`, row);
    }
  };
  return {
    sourceTotals,
    memoryRelevance,
    world: (world) => getWorldById(database, world),
    npc: (world, npc) => getNpcWithState(database, world, npc),
    gameProfile: (world, npc) => getNpcGameProfile(database, world, npc),
    capabilities: async (world, npc, limit = 500) =>
      limit === 0
        ? []
        : database
            .select(getTableColumns(npcCapabilities))
            .from(npcCapabilities)
            .innerJoin(entities, eq(entities.id, npcCapabilities.npcId))
            .where(
              and(eq(entities.worldId, world), eq(npcCapabilities.npcId, npc)),
            )
            .orderBy(npcCapabilities.capabilityKey)
            .limit(CONTEXT_CANDIDATE_CAP),
    entity: async (world, id) => {
      const key = `${world}:${id}`;
      if (!entityCache.has(key))
        entityCache.set(key, await getEntity(database, world, id));
      return entityCache.get(key)!;
    },
    interaction: async (world, npc, id) => {
      const key = `${world}:${npc}:${id}`;
      if (!interactionCache.has(key))
        interactionCache.set(
          key,
          await getInteraction(database, world, npc, id),
        );
      return interactionCache.get(key)!;
    },
    context: (world, id) => getInteractionContext(database, world, id),
    history: async (world, npc, contextId, window) => {
      if (window?.limit === 0) return [];
      const rows = await database
        .select()
        .from(interactions)
        .where(
          and(
            eq(interactions.worldId, world),
            eq(interactions.npcId, npc),
            eq(interactions.contextId, contextId),
            window ? lte(interactions.createdAt, window.before) : undefined,
            window ? ne(interactions.id, window.exclude) : undefined,
          ),
        )
        .orderBy(desc(interactions.createdAt), interactions.id)
        .limit(window?.limit ?? CONTEXT_CANDIDATE_CAP);
      await warmEntities(
        world,
        rows.map((row) => row.speakerEntityId),
      );
      return rows;
    },
    knowledge: async (world, npc, selection) => {
      knowledgeScope = `${world}:${npc}`;
      claimIds = [];
      knowledgeBatch = undefined;
      if (selection?.limit === 0) return [];
      const relevant = selection
        ? or(
            termsMatch(sql`k.claim_text`, selection.terms),
            among(sql`k.subject_entity_id`, selection.entityIds),
            among(sql`k.object_entity_id`, selection.entityIds),
          )!
        : sql`true`;
      // UNION (not UNION ALL) terminates cycles. Parent LIMIT stops recursive
      // consumption at cap+1; there is no final sort/materialization of closure.
      const reachable = await database.execute<{
        id: string;
      }>(sql`with recursive seeds as (
        select k.id from npc_knowledge k where k.world_id=${world} and k.npc_id=${npc}
          and k.status in ('current','disputed') and ${relevant}
        order by k.id limit ${CONTEXT_CANDIDATE_CAP + 1}
      ), reachable(id) as (
        select id from seeds union
        select case when c.claim_a_id=r.id then c.claim_b_id else c.claim_a_id end
        from reachable r join knowledge_conflicts c on (c.claim_a_id=r.id or c.claim_b_id=r.id)
        where c.world_id=${world} and c.npc_id=${npc}
      ) select id from reachable limit ${CONTEXT_CANDIDATE_CAP + 1}`);
      if (reachable.rows.length > CONTEXT_CANDIDATE_CAP)
        throw new ContextUnavailableError();
      claimIds = reachable.rows.map((row) => row.id);
      if (!claimIds.length) return [];
      const rows = await database
        .select()
        .from(npcKnowledge)
        .where(
          and(
            eq(npcKnowledge.worldId, world),
            eq(npcKnowledge.npcId, npc),
            inArray(npcKnowledge.id, claimIds),
            inArray(npcKnowledge.status, ["current", "disputed"]),
          ),
        )
        .orderBy(npcKnowledge.id);
      claimIds = rows.map((row) => row.id);
      await warmEntities(
        world,
        rows.flatMap((row) => [row.subjectEntityId, row.objectEntityId]),
      );
      return rows;
    },
    conflicts: async (world, npc, ids = claimIds) => {
      if (!ids.length) return [];
      const rows = await database
        .select()
        .from(knowledgeConflicts)
        .where(
          and(
            eq(knowledgeConflicts.worldId, world),
            eq(knowledgeConflicts.npcId, npc),
            or(
              inArray(knowledgeConflicts.claimAId, ids),
              inArray(knowledgeConflicts.claimBId, ids),
            ),
          ),
        )
        .orderBy(knowledgeConflicts.id)
        .limit(CONTEXT_CANDIDATE_CAP + 1);
      if (rows.length > CONTEXT_CANDIDATE_CAP)
        throw new ContextUnavailableError();
      return rows;
    },
    memories: async (world, npc, selection) => {
      memoryScope = `${world}:${npc}`;
      memoryIds = [];
      memoryBatch = undefined;
      if (selection?.limit === 0) return [];
      const relevant = selection
        ? or(
            termsMatch(sql`${npcMemories.summary}`, selection.terms),
            sql`exists(select 1 from memory_sources s where s.memory_id=npc_memories.id and
        (${among(
          sql`s.source_entity_id`,
          selection.participantIds,
        )} or ${among(sql`s.source_interaction_id`, selection.interactionIds)}))`,
          )
        : sql`true`;
      const rows = await database
        .select({
          ...getTableColumns(npcMemories),
          sceneRelevant: selection
            ? sql<boolean>`exists(select 1 from memory_sources s where s.memory_id=npc_memories.id and ${among(sql`s.source_interaction_id`, selection.interactionIds)})`
            : sql<boolean>`false`,
          participantRelevant: selection
            ? sql<boolean>`exists(select 1 from memory_sources s where s.memory_id=npc_memories.id and ${among(sql`s.source_entity_id`, selection.participantIds)})`
            : sql<boolean>`false`,
        })
        .from(npcMemories)
        .where(
          and(
            eq(npcMemories.worldId, world),
            eq(npcMemories.npcId, npc),
            eq(npcMemories.status, "active"),
            relevant,
          ),
        )
        .orderBy(
          desc(npcMemories.importance),
          desc(npcMemories.createdAt),
          npcMemories.id,
        )
        .limit(CONTEXT_CANDIDATE_CAP + 1);
      if (rows.length > CONTEXT_CANDIDATE_CAP)
        throw new ContextUnavailableError();
      memoryIds = rows.map((row) => row.id);
      return rows.map(({ sceneRelevant, participantRelevant, ...row }) => {
        memoryRelevance.set(row.id, {
          scene: sceneRelevant,
          participant: participantRelevant,
        });
        return row;
      });
    },
    relationships: async (world, npc, participants = []) =>
      participants.length === 0
        ? []
        : database
            .select()
            .from(relationships)
            .where(
              and(
                eq(relationships.worldId, world),
                eq(relationships.sourceEntityId, npc),
                inArray(relationships.targetEntityId, participants),
              ),
            )
            .orderBy(relationships.targetEntityId, relationships.id)
            .limit(CONTEXT_CANDIDATE_CAP + 1),
    knowledgeSources: async (world, npc, id, limit = 4) => {
      if (knowledgeScope !== `${world}:${npc}`) return [];
      if (!knowledgeBatch || knowledgeBatchLimit !== limit) {
        knowledgeBatchLimit = limit;
        knowledgeBatch = new Map();
        if (claimIds.length) {
          const ranked = database
            .select({
              ...getTableColumns(knowledgeSources),
              total:
                sql<number>`count(*) over(partition by ${knowledgeSources.knowledgeId})::int`.as(
                  "source_total",
                ),
              rank: sql<number>`row_number() over(partition by ${knowledgeSources.knowledgeId} order by ${knowledgeSources.createdAt} desc,${knowledgeSources.id})`.as(
                "source_rank",
              ),
            })
            .from(knowledgeSources)
            .innerJoin(
              npcKnowledge,
              eq(npcKnowledge.id, knowledgeSources.knowledgeId),
            )
            .where(
              and(
                eq(npcKnowledge.worldId, world),
                eq(npcKnowledge.npcId, npc),
                inArray(knowledgeSources.knowledgeId, claimIds),
              ),
            )
            .as("ranked_sources");
          const rows = await database
            .select()
            .from(ranked)
            .where(lte(ranked.rank, Math.max(1, limit)));
          await warmEntities(
            world,
            rows.map((row) => row.sourceEntityId),
          );
          for (const { total, rank, ...row } of rows) {
            sourceTotals.set(`knowledge:${row.knowledgeId}`, total);
            if (rank > limit) continue;
            const group = knowledgeBatch.get(row.knowledgeId) ?? [];
            group.push(row);
            knowledgeBatch.set(row.knowledgeId, group);
          }
        }
      }
      return knowledgeBatch.get(id) ?? [];
    },
    memorySources: async (world, npc, id, limit = 4) => {
      if (memoryScope !== `${world}:${npc}`) return [];
      if (!memoryBatch || memoryBatchLimit !== limit) {
        memoryBatchLimit = limit;
        memoryBatch = new Map();
        if (memoryIds.length) {
          const ranked = database
            .select({
              ...getTableColumns(memorySources),
              total:
                sql<number>`count(*) over(partition by ${memorySources.memoryId})::int`.as(
                  "source_total",
                ),
              rank: sql<number>`row_number() over(partition by ${memorySources.memoryId} order by ${memorySources.createdAt} desc,${memorySources.id})`.as(
                "source_rank",
              ),
            })
            .from(memorySources)
            .innerJoin(npcMemories, eq(npcMemories.id, memorySources.memoryId))
            .where(
              and(
                eq(npcMemories.worldId, world),
                eq(npcMemories.npcId, npc),
                inArray(memorySources.memoryId, memoryIds),
              ),
            )
            .as("ranked_sources");
          const rows = await database
            .select()
            .from(ranked)
            .where(lte(ranked.rank, Math.max(1, limit)));
          await warmEntities(
            world,
            rows.map((row) => row.sourceEntityId),
          );
          const sourceIds = [
            ...new Set(
              rows.flatMap((row) =>
                row.sourceInteractionId ? [row.sourceInteractionId] : [],
              ),
            ),
          ];
          if (sourceIds.length) {
            for (const id of sourceIds)
              interactionCache.set(`${world}:${npc}:${id}`, null);
            for (let offset = 0; offset < sourceIds.length; offset += 1000) {
              for (const row of await database
                .select()
                .from(interactions)
                .where(
                  and(
                    eq(interactions.worldId, world),
                    eq(interactions.npcId, npc),
                    inArray(
                      interactions.id,
                      sourceIds.slice(offset, offset + 1000),
                    ),
                  ),
                ))
                interactionCache.set(`${world}:${npc}:${row.id}`, row);
            }
          }
          for (const { total, rank, ...row } of rows) {
            sourceTotals.set(`memory:${row.memoryId}`, total);
            if (rank > limit) continue;
            const group = memoryBatch.get(row.memoryId) ?? [];
            group.push(row);
            memoryBatch.set(row.memoryId, group);
          }
        }
      }
      return memoryBatch.get(id) ?? [];
    },
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
