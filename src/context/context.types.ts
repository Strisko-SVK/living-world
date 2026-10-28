import type { getWorldById } from "../domains/world/world.repository.js";
import type { getEntity } from "../domains/entity/entity.repository.js";
import type {
  getNpcWithState,
  getNpcGameProfile,
  listNpcCapabilities,
} from "../domains/npc/npc.repository.js";
import type {
  getInteraction,
  getInteractionContext,
  listInteractionsForNpc,
} from "../domains/interaction/interaction.repository.js";
import type {
  listKnowledge,
  listKnowledgeSources,
  listKnowledgeConflicts,
} from "../domains/knowledge/knowledge.repository.js";
import type {
  listMemories,
  listMemorySources,
} from "../domains/memory/memory.repository.js";
import type { listRelationshipsFrom } from "../domains/relationship/relationship.repository.js";

type StoredNpc = NonNullable<Awaited<ReturnType<typeof getNpcWithState>>>;
export type NpcSnapshot = Omit<StoredNpc, "state"> & {
  state: StoredNpc["state"] | null;
};
export interface ContextSelection {
  terms: string[];
  entityIds: string[];
  participantIds: string[];
  interactionIds: string[];
  limit: number;
}
export interface ContextReader {
  // Populated by bounded SQL source batches; omitted rows remain explicit.
  sourceTotals?: Map<string, number>;
  memoryRelevance?: Map<string, { scene: boolean; participant: boolean }>;
  world(
    worldId: string,
  ): Promise<Awaited<ReturnType<typeof getWorldById>> | null>;
  npc(worldId: string, npcId: string): Promise<NpcSnapshot | null>;
  gameProfile(
    worldId: string,
    npcId: string,
  ): ReturnType<typeof getNpcGameProfile>;
  capabilities(
    worldId: string,
    npcId: string,
    limit?: number,
  ): ReturnType<typeof listNpcCapabilities>;
  entity(
    worldId: string,
    entityId: string,
  ): Promise<Awaited<ReturnType<typeof getEntity>> | null>;
  interaction(
    worldId: string,
    npcId: string,
    interactionId: string,
  ): ReturnType<typeof getInteraction>;
  context(
    worldId: string,
    contextId: string,
  ): Promise<Awaited<ReturnType<typeof getInteractionContext>> | null>;
  history(
    worldId: string,
    npcId: string,
    contextId: string,
    window?: { before: Date; exclude: string; limit: number },
  ): ReturnType<typeof listInteractionsForNpc>;
  knowledge(
    worldId: string,
    npcId: string,
    selection?: ContextSelection,
  ): ReturnType<typeof listKnowledge>;
  knowledgeSources(
    worldId: string,
    npcId: string,
    knowledgeId: string,
    limit?: number,
  ): ReturnType<typeof listKnowledgeSources>;
  conflicts(
    worldId: string,
    npcId: string,
    claimIds?: string[],
  ): ReturnType<typeof listKnowledgeConflicts>;
  memories(
    worldId: string,
    npcId: string,
    selection?: ContextSelection,
  ): ReturnType<typeof listMemories>;
  memorySources(
    worldId: string,
    npcId: string,
    memoryId: string,
    limit?: number,
  ): ReturnType<typeof listMemorySources>;
  relationships(
    worldId: string,
    npcId: string,
    participantIds?: string[],
  ): ReturnType<typeof listRelationshipsFrom>;
}
export type Interaction = NonNullable<
  Awaited<ReturnType<ContextReader["interaction"]>>
>;
export type Entity = NonNullable<Awaited<ReturnType<ContextReader["entity"]>>>;
export type Knowledge = Awaited<ReturnType<ContextReader["knowledge"]>>[number];
export type Memory = Awaited<ReturnType<ContextReader["memories"]>>[number];
export type KnowledgeSource = Awaited<
  ReturnType<ContextReader["knowledgeSources"]>
>[number];
export type MemorySource = Awaited<
  ReturnType<ContextReader["memorySources"]>
>[number];
export type Conflict = Awaited<ReturnType<ContextReader["conflicts"]>>[number];
export type Relationship = Awaited<
  ReturnType<ContextReader["relationships"]>
>[number];
export type Category =
  "knowledge" | "memories" | "relationships" | "history" | "capabilities";
export type ContextLimits = Record<Category | "sourcesPerRecord", number>;
export interface ContextOptions {
  maxBytes?: number;
  limits?: Partial<Record<Category | "sourcesPerRecord", number>>;
}
export interface ContextRequest extends ContextOptions {
  worldId: string;
  npcId: string;
  interactionId: string;
}
export interface Selected<T> {
  record: T;
  reasons: string[];
}
export interface Provenance<T> {
  sources: T[];
  total: number;
  omitted: number;
  unavailable: number;
}
export interface KnowledgeGroup {
  claims: Array<
    Selected<Knowledge> & { provenance: Provenance<KnowledgeSource> }
  >;
  conflicts: Conflict[];
  reasons: string[];
}
export interface SelectionStats {
  retrieved: number;
  excluded: number;
  irrelevant: number;
  unavailable: number;
  omittedByLimit: number;
  omittedByBudget: number;
  selected: number;
}
export interface NpcContextBundle {
  version: 1;
  world: Pick<
    NonNullable<Awaited<ReturnType<ContextReader["world"]>>>,
    "id" | "key" | "name" | "systemType"
  >;
  npc: NpcSnapshot;
  gameProfile: Awaited<ReturnType<ContextReader["gameProfile"]>>;
  current: {
    interaction: Interaction;
    requester: Entity | null;
    context: Pick<
      NonNullable<Awaited<ReturnType<ContextReader["context"]>>>,
      "id" | "worldId" | "contextType" | "status" | "linkedLocationEntityId"
    > | null;
  };
  knowledge: KnowledgeGroup[];
  memories: Array<Selected<Memory> & { provenance: Provenance<MemorySource> }>;
  relationships: Array<Selected<Relationship> & { participant: Entity }>;
  history: Array<Selected<Interaction>>;
  capabilities: Awaited<ReturnType<ContextReader["capabilities"]>>;
  missing: string[];
  temporal: {
    gameTime: null;
    sceneChronology: "unknown";
    parallelScenes: "not_sequenced";
    timestamps: "technical_storage_only";
  };
  presence: { scenePresence: "not_established"; remoteReachability: "unknown" };
  retrieval: {
    limits: ContextLimits;
    categories: Record<Category, SelectionStats>;
    provenanceTruncated: boolean;
    scope: "own_npc_same_scene_history";
  };
  budget: {
    maxBytes: number;
    estimatedBytes: number;
    estimator: "canonical_json_utf8";
    truncated: boolean;
  };
}
