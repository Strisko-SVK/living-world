import { z } from "zod";
import type {
  Category,
  ContextReader,
  ContextRequest,
  Knowledge,
  KnowledgeGroup,
  KnowledgeSource,
  MemorySource,
  NpcContextBundle,
  Provenance,
  SelectionStats,
} from "./context.types.js";

const limit = z.number().int().min(0).max(500);
const requestSchema = z.object({
  worldId: z.string().uuid(),
  npcId: z.string().uuid(),
  interactionId: z.string().uuid(),
  maxBytes: z.number().int().positive().max(10_000_000).default(48_000),
  limits: z
    .object({
      knowledge: limit.default(12),
      memories: limit.default(8),
      relationships: limit.default(8),
      history: limit.default(10),
      capabilities: limit.default(12),
      sourcesPerRecord: limit.default(4),
    })
    .prefault({}),
});
const categories: Category[] = [
  "knowledge",
  "memories",
  "relationships",
  "history",
  "capabilities",
];
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const recent = (
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
) => b.createdAt.getTime() - a.createdAt.getTime() || compare(a.id, b.id);
const scoped =
  (world: string, npc: string) => (row: { worldId: string; npcId: string }) =>
    row.worldId === world && row.npcId === npc;
const words = (text: string) =>
  new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 128));
const overlap = (text: string, terms: Set<string>) =>
  [...words(text)].filter((term) => terms.has(term)).length;

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
export function estimateContextBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(canonical(value)), "utf8");
}
export class ContextUnavailableError extends Error {
  constructor() {
    super("World, NPC or interaction is unavailable in the requested scope.");
    this.name = "ContextUnavailableError";
  }
}
export class ContextBudgetExceededError extends Error {
  constructor(
    readonly requiredBytes: number,
    readonly maxBytes: number,
  ) {
    super("Essential NPC context exceeds the configured byte budget.");
    this.name = "ContextBudgetExceededError";
  }
}
const stats = (retrieved: number): SelectionStats => ({
  retrieved,
  excluded: 0,
  irrelevant: 0,
  unavailable: 0,
  omittedByLimit: 0,
  omittedByBudget: 0,
  selected: 0,
});

export function createContextBuilder(reader: ContextReader) {
  return async (request: ContextRequest): Promise<NpcContextBundle> => {
    const config = requestSchema.parse(request);
    const { worldId, npcId, interactionId, limits } = config;
    const own = scoped(worldId, npcId);
    // Production reads share one transaction connection; do not queue concurrent
    // pg queries on that client. The read-only snapshot supplies consistency.
    const world = await reader.world(worldId);
    const npc = await reader.npc(worldId, npcId);
    const interaction = await reader.interaction(worldId, npcId, interactionId);
    if (
      !world ||
      world.id !== worldId ||
      !npc ||
      npc.npc.worldId !== worldId ||
      npc.npc.entityId !== npcId ||
      !interaction ||
      !own(interaction) ||
      interaction.id !== interactionId
    )
      throw new ContextUnavailableError();
    const missing: string[] = [];
    const entityCache = new Map<string, ReturnType<ContextReader["entity"]>>();
    const entity = (id: string) => {
      if (!entityCache.has(id))
        entityCache.set(
          id,
          reader
            .entity(worldId, id)
            .then((row) =>
              row?.worldId === worldId && row.id === id ? row : null,
            ),
        );
      return entityCache.get(id)!;
    };
    const scene = await reader.context(worldId, interaction.contextId);
    const requester = interaction.speakerEntityId
      ? await entity(interaction.speakerEntityId)
      : null;
    const profile = await reader.gameProfile(worldId, npcId);
    const context =
      scene?.worldId === worldId && scene.id === interaction.contextId
        ? {
            id: scene.id,
            worldId: scene.worldId,
            contextType: scene.contextType,
            status: scene.status,
            linkedLocationEntityId: scene.linkedLocationEntityId,
          }
        : null;
    if (!context) missing.push("origin_context_unavailable");
    else if (context.status !== "active")
      missing.push("origin_context_inactive");
    if (!requester)
      missing.push(
        interaction.speakerEntityId ? "speaker_unavailable" : "speaker_unknown",
      );
    const state = npc.state?.npcId === npcId ? npc.state : null;
    const gameProfile = profile?.npcId === npcId ? profile : null;
    if (!state) missing.push("npc_state_missing");
    if (!gameProfile) missing.push("game_profile_missing");
    const rawHistory =
      context?.status === "active"
        ? await reader.history(worldId, npcId, context.id)
        : [];
    const rawKnowledge = await reader.knowledge(worldId, npcId);
    const rawMemories = await reader.memories(worldId, npcId);
    const rawRelationships = await reader.relationships(worldId, npcId);
    const rawConflicts = await reader.conflicts(worldId, npcId);
    const rawCapabilities = await reader.capabilities(worldId, npcId);
    const history = rawHistory
      .filter(
        (row) =>
          own(row) &&
          row.contextId === context?.id &&
          row.id !== interactionId &&
          row.createdAt.getTime() <= interaction.createdAt.getTime(),
      )
      .sort(recent);
    const eligibleKnowledge = rawKnowledge.filter(
      (row) =>
        own(row) && (row.status === "current" || row.status === "disputed"),
    );
    const knowledge: Knowledge[] = [];
    let missingKnowledgeReferences = 0;
    for (const row of eligibleKnowledge) {
      if (
        (row.subjectEntityId && !(await entity(row.subjectEntityId))) ||
        (row.objectEntityId && !(await entity(row.objectEntityId)))
      ) {
        missingKnowledgeReferences++;
        continue;
      }
      knowledge.push(row);
    }
    const memories = rawMemories.filter(
      (row) => own(row) && row.status === "active",
    );
    const conflicts = rawConflicts
      .filter(own)
      .sort((a, b) => compare(a.id, b.id));
    const capabilities = rawCapabilities
      .filter((row) => row.npcId === npcId)
      .sort((a, b) => compare(a.capabilityKey, b.capabilityKey));
    const participants = new Map<string, NonNullable<typeof requester>>();
    if (requester) participants.set(requester.id, requester);
    for (const row of history.slice(0, limits.history))
      if (row.speakerEntityId && row.speakerEntityId !== npcId) {
        const participant = await entity(row.speakerEntityId);
        if (participant) participants.set(participant.id, participant);
      }
    const relationships = rawRelationships
      .filter(
        (row) =>
          row.worldId === worldId &&
          row.sourceEntityId === npcId &&
          participants.has(row.targetEntityId),
      )
      .sort(
        (a, b) =>
          Number(b.targetEntityId === requester?.id) -
            Number(a.targetEntityId === requester?.id) ||
          compare(a.targetEntityId, b.targetEntityId) ||
          compare(a.id, b.id),
      );
    const currentTerms = words(interaction.requestText);
    const sceneTerms = words(
      history
        .slice(0, limits.history)
        .map((row) => row.requestText)
        .join(" "),
    );
    const relatedEntities = new Set([
      npcId,
      ...participants.keys(),
      ...(context?.linkedLocationEntityId
        ? [context.linkedLocationEntityId]
        : []),
    ]);
    const sceneInteractions = new Set([
      interactionId,
      ...history.map((row) => row.id),
    ]);
    const knowledgeIds = new Set(knowledge.map((row) => row.id)),
      memoryIds = new Set(memories.map((row) => row.id));
    const validEntity = async (id: string | null) =>
      !id || !!(await entity(id));
    const validInteraction = async (id: string | null) => {
      if (!id) return true;
      const row = await reader.interaction(worldId, npcId, id);
      return !!row && own(row) && row.id === id;
    };
    async function provenance<T extends KnowledgeSource | MemorySource>(
      rows: T[],
      parentId: string,
      kind: "knowledge" | "memory",
    ): Promise<Provenance<T>> {
      const owned = rows
        .filter((row) =>
          "knowledgeId" in row
            ? kind === "knowledge" && row.knowledgeId === parentId
            : kind === "memory" && row.memoryId === parentId,
        )
        .sort(recent);
      const valid: T[] = [];
      for (const row of owned) {
        if (!(await validEntity(row.sourceEntityId))) continue;
        if (
          "sourceInteractionId" in row &&
          !(await validInteraction(row.sourceInteractionId))
        )
          continue;
        if (
          "sourceKnowledgeId" in row &&
          row.sourceKnowledgeId &&
          !knowledgeIds.has(row.sourceKnowledgeId)
        )
          continue;
        if (
          "sourceMemoryId" in row &&
          row.sourceMemoryId &&
          !memoryIds.has(row.sourceMemoryId)
        )
          continue;
        valid.push(row);
      }
      return {
        sources: valid,
        total: owned.length,
        omitted: 0,
        unavailable: owned.length - valid.length,
      };
    }
    const limitProvenance = <T>(value: Provenance<T>): Provenance<T> => ({
      ...value,
      sources: value.sources.slice(0, limits.sourcesPerRecord),
      omitted: Math.max(0, value.sources.length - limits.sourcesPerRecord),
    });
    const knowledgeProvenance = new Map<string, Provenance<KnowledgeSource>>();
    for (const row of knowledge)
      knowledgeProvenance.set(
        row.id,
        await provenance(
          await reader.knowledgeSources(worldId, npcId, row.id),
          row.id,
          "knowledge",
        ),
      );
    const memoryProvenance = new Map<string, Provenance<MemorySource>>();
    for (const row of memories)
      memoryProvenance.set(
        row.id,
        await provenance(
          await reader.memorySources(worldId, npcId, row.id),
          row.id,
          "memory",
        ),
      );
    const rankKnowledge = (row: Knowledge) => {
      const reasons: string[] = [];
      let score = 0;
      if (
        context?.linkedLocationEntityId &&
        [row.subjectEntityId, row.objectEntityId].includes(
          context.linkedLocationEntityId,
        )
      ) {
        score += 20;
        reasons.push("scene_location");
      }
      if (
        [row.subjectEntityId, row.objectEntityId].some(
          (id) => id && relatedEntities.has(id),
        )
      ) {
        score += 10;
        reasons.push("known_participant_or_self");
      }
      const current = overlap(row.claimText, currentTerms),
        scene = overlap(row.claimText, sceneTerms);
      if (current) {
        score += current * 3;
        reasons.push("request_terms");
      }
      if (scene) {
        score += scene;
        reasons.push("scene_history_terms");
      }
      return { score, reasons };
    };
    // Connected conflict components are indivisible: budgets never present one
    // accessible side as if its explicitly recorded contradiction did not exist.
    const byId = new Map(knowledge.map((row) => [row.id, row]));
    const visited = new Set<string>();
    const groups: Array<{ value: KnowledgeGroup; score: number; key: string }> =
      [];
    let unavailableKnowledge = missingKnowledgeReferences,
      irrelevantKnowledge = 0;
    for (const claim of [...knowledge].sort((a, b) => compare(a.id, b.id))) {
      if (visited.has(claim.id)) continue;
      const ids = new Set<string>(),
        queue = [claim.id];
      let unavailable = false;
      while (queue.length) {
        const id = queue.shift()!;
        if (ids.has(id)) continue;
        if (!byId.has(id)) {
          unavailable = true;
          continue;
        }
        ids.add(id);
        visited.add(id);
        for (const conflict of conflicts) {
          if (conflict.claimAId === id) queue.push(conflict.claimBId);
          if (conflict.claimBId === id) queue.push(conflict.claimAId);
        }
      }
      if (unavailable) {
        unavailableKnowledge += ids.size;
        continue;
      }
      const claims = [...ids].sort(compare).map((id) => byId.get(id)!);
      const ranks = claims.map(rankKnowledge),
        score = Math.max(...ranks.map((rank) => rank.score));
      if (!score) {
        irrelevantKnowledge += ids.size;
        continue;
      }
      const groupConflicts = conflicts.filter(
        (conflict) => ids.has(conflict.claimAId) && ids.has(conflict.claimBId),
      );
      groups.push({
        score,
        key: claims[0].id,
        value: {
          claims: claims.map((record, i) => ({
            record,
            reasons: ranks[i].reasons.length
              ? ranks[i].reasons
              : ["conflict_partner"],
            provenance: limitProvenance(knowledgeProvenance.get(record.id)!),
          })),
          conflicts: groupConflicts,
          reasons: groupConflicts.length
            ? ["subjective_beliefs", "conflict_group"]
            : ["subjective_belief"],
        },
      });
    }
    groups.sort((a, b) => b.score - a.score || compare(a.key, b.key));
    const rankedMemories = memories
      .map((record) => {
        const provenance = memoryProvenance.get(record.id)!;
        const reasons: string[] = [];
        let score = 0;
        if (
          provenance.sources.some(
            (source) =>
              source.sourceInteractionId &&
              sceneInteractions.has(source.sourceInteractionId),
          )
        ) {
          score += 20;
          reasons.push("scene_interaction_provenance");
        }
        if (
          provenance.sources.some(
            (source) =>
              source.sourceEntityId && participants.has(source.sourceEntityId),
          )
        ) {
          score += 10;
          reasons.push("participant_provenance");
        }
        const current = overlap(record.summary, currentTerms),
          scene = overlap(record.summary, sceneTerms);
        if (current) {
          score += current * 3;
          reasons.push("request_terms");
        }
        if (scene) {
          score += scene;
          reasons.push("scene_history_terms");
        }
        return {
          score,
          value: { record, reasons, provenance: limitProvenance(provenance) },
        };
      })
      .filter((row) => row.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.value.record.importance - a.value.record.importance ||
          recent(a.value.record, b.value.record),
      );
    const selection: Record<Category, SelectionStats> = {
      knowledge: stats(rawKnowledge.length),
      memories: stats(rawMemories.length),
      relationships: stats(rawRelationships.length),
      history: stats(rawHistory.length),
      capabilities: stats(rawCapabilities.length),
    };
    selection.knowledge.excluded =
      rawKnowledge.length - eligibleKnowledge.length;
    selection.knowledge.unavailable = unavailableKnowledge;
    selection.knowledge.irrelevant = irrelevantKnowledge;
    selection.memories.excluded = rawMemories.length - memories.length;
    selection.memories.irrelevant = memories.length - rankedMemories.length;
    selection.relationships.excluded =
      rawRelationships.length - relationships.length;
    selection.history.excluded = rawHistory.length - history.length;
    selection.capabilities.excluded =
      rawCapabilities.length - capabilities.length;
    if (!history.length) missing.push("scene_history_empty_or_unavailable");
    if (!knowledge.length) missing.push("eligible_knowledge_unavailable");
    if (!memories.length) missing.push("active_memories_unavailable");
    if (!relationships.length)
      missing.push("participant_relationships_unavailable");
    const bundle: NpcContextBundle = {
      version: 1,
      world: {
        id: world.id,
        key: world.key,
        name: world.name,
        systemType: world.systemType,
      },
      npc: { npc: npc.npc, state },
      gameProfile,
      current: { interaction, requester, context },
      knowledge: [],
      memories: [],
      relationships: [],
      history: [],
      capabilities: [],
      missing,
      temporal: {
        gameTime: null,
        sceneChronology: "unknown",
        parallelScenes: "not_sequenced",
        timestamps: "technical_storage_only",
      },
      presence: {
        scenePresence: "not_established",
        remoteReachability: "unknown",
      },
      retrieval: {
        limits,
        categories: selection,
        provenanceTruncated: false,
        scope: "own_npc_same_scene_history",
      },
      budget: {
        maxBytes: config.maxBytes,
        estimatedBytes: 0,
        estimator: "canonical_json_utf8",
        truncated: false,
      },
    };
    type Candidate = {
      category: Category;
      count: number;
      add: () => void;
      remove: () => void;
    };
    const candidates: Candidate[] = [];
    const enqueue = <T>(
      category: Category,
      values: T[],
      destination: T[],
      count: (value: T) => number = () => 1,
    ) => {
      let used = 0;
      for (const value of values) {
        const size = count(value);
        if (used + size > limits[category]) {
          selection[category].omittedByLimit += size;
          continue;
        }
        used += size;
        selection[category].omittedByBudget += size;
        candidates.push({
          category,
          count: size,
          add: () => {
            destination.push(value);
          },
          remove: () => {
            destination.pop();
          },
        });
      }
    };
    enqueue(
      "knowledge",
      groups.map((group) => group.value),
      bundle.knowledge,
      (group) => group.claims.length,
    );
    enqueue(
      "memories",
      rankedMemories.map((row) => row.value),
      bundle.memories,
    );
    enqueue(
      "relationships",
      relationships.map((record) => ({
        record,
        participant: participants.get(record.targetEntityId)!,
        reasons: [
          record.targetEntityId === requester?.id
            ? "current_requester"
            : "scene_history_participant",
        ],
      })),
      bundle.relationships,
    );
    enqueue(
      "history",
      history.map((record) => ({
        record,
        reasons: ["same_scene", "own_npc", "technical_recency"],
      })),
      bundle.history,
    );
    enqueue("capabilities", capabilities, bundle.capabilities);
    const measure = () => {
      bundle.retrieval.provenanceTruncated =
        bundle.knowledge.some((group) =>
          group.claims.some((claim) => claim.provenance.omitted > 0),
        ) || bundle.memories.some((memory) => memory.provenance.omitted > 0);
      bundle.budget.truncated =
        bundle.retrieval.provenanceTruncated ||
        categories.some(
          (category) =>
            selection[category].omittedByBudget > 0 ||
            selection[category].omittedByLimit > 0,
        );
      for (let i = 0; i < 6; i++) {
        const bytes = estimateContextBytes(bundle);
        if (bytes === bundle.budget.estimatedBytes) break;
        bundle.budget.estimatedBytes = bytes;
      }
      return bundle.budget.estimatedBytes;
    };
    if (measure() > config.maxBytes)
      throw new ContextBudgetExceededError(
        bundle.budget.estimatedBytes,
        config.maxBytes,
      );
    for (const candidate of candidates) {
      candidate.add();
      selection[candidate.category].selected += candidate.count;
      selection[candidate.category].omittedByBudget -= candidate.count;
      if (measure() > config.maxBytes) {
        candidate.remove();
        selection[candidate.category].selected -= candidate.count;
        selection[candidate.category].omittedByBudget += candidate.count;
        measure();
      }
    }
    return bundle;
  };
}
