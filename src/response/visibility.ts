import type {
  Interaction,
  NpcContextBundle,
} from "../context/context.types.js";

export class VisibilityBlocked extends Error {
  constructor() {
    super("NPC perception or disclosure cannot be established.");
  }
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const pick = (value: unknown, keys: string[]) =>
  Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(object(value), key))
      .map((key) => [key, object(value)[key]]),
  );
const before = (value: Date, anchor: Date) =>
  value instanceof Date && value.getTime() <= anchor.getTime();
export interface PermittedContext {
  sections: Record<string, unknown>;
  // Validation-only. Never send excluded text back to the provider or diagnostics.
  excludedText: string[];
  omissions: {
    history: number;
    knowledgeGroups: number;
    memories: number;
    relationships: number;
  };
}
export function filterResponseContext(
  bundle: NpcContextBundle,
  expected: Interaction,
): PermittedContext {
  const { worldId, npcId, id, contextId } = expected;
  const { interaction, requester, context } = bundle.current;
  const npc = bundle.npc.npc,
    state = bundle.npc.state;
  if (
    bundle.world.id !== worldId ||
    npc.worldId !== worldId ||
    npc.entityId !== npcId ||
    npc.status !== "active" ||
    npc.lifecycleState !== "active" ||
    interaction.id !== id ||
    interaction.worldId !== worldId ||
    interaction.npcId !== npcId ||
    interaction.contextId !== contextId ||
    interaction.requestText !== expected.requestText ||
    interaction.speakerEntityId !== expected.speakerEntityId ||
    interaction.communicationMode !== expected.communicationMode ||
    interaction.traceId !== expected.traceId ||
    interaction.createdAt.getTime() !== expected.createdAt.getTime() ||
    !context ||
    context.worldId !== worldId ||
    context.id !== contextId ||
    context.status !== "active" ||
    interaction.communicationMode !== "local" ||
    !context.linkedLocationEntityId ||
    !state ||
    state.npcId !== npcId ||
    state.locationCertainty !== "certain" ||
    state.currentLocationId !== context.linkedLocationEntityId ||
    (interaction.speakerEntityId === null && requester !== null) ||
    (interaction.speakerEntityId !== null &&
      (!requester ||
        requester.id !== interaction.speakerEntityId ||
        requester.worldId !== worldId))
  )
    throw new VisibilityBlocked();
  const beliefs: unknown[] = [];
  const excludedText: string[] = [];
  let omittedKnowledge = 0;
  for (const group of bundle.knowledge) {
    const ids = new Set(group.claims.map((c) => c.record.id));
    const permitted =
      group.claims.length > 0 &&
      group.conflicts.every(
        (c) =>
          c.worldId === worldId &&
          c.npcId === npcId &&
          ids.has(c.claimAId) &&
          ids.has(c.claimBId),
      ) &&
      group.claims.every(
        ({ record: r, provenance: p }) =>
          r.worldId === worldId &&
          r.npcId === npcId &&
          r.secrecy === "public" &&
          (r.status === "current" || r.status === "disputed") &&
          before(r.createdAt, interaction.createdAt) &&
          before(r.updatedAt, interaction.createdAt) &&
          p.total > 0 &&
          p.total === p.sources.length &&
          p.omitted === 0 &&
          p.unavailable === 0 &&
          p.sources.every(
            (s) =>
              s.knowledgeId === r.id &&
              ["witnessed", "heard", "read", "official"].includes(
                s.sourceType,
              ) &&
              (s.sourceEntityId === npcId ||
                (requester !== null && s.sourceEntityId === requester.id)) &&
              !s.sourceKnowledgeId &&
              !s.sourceMemoryId &&
              !s.externalRef &&
              before(s.createdAt, interaction.createdAt),
          ),
      );
    if (!permitted) {
      omittedKnowledge++;
      excludedText.push(...group.claims.map((c) => c.record.claimText));
      continue;
    }
    beliefs.push({
      subjective: true,
      contradictory: group.conflicts.length > 0,
      claims: group.claims.map(({ record: r }) => ({
        text: r.claimText,
        classification: r.classification,
        confidence: r.confidence,
        status: r.status,
      })),
    });
  }
  // Ownership alone proves neither historical perception nor permission to
  // disclose memories/relationship notes. No visibility model exists for them.
  for (const memory of bundle.memories)
    excludedText.push(memory.record.summary);
  for (const history of bundle.history) {
    excludedText.push(history.record.requestText);
    if (history.record.responseText)
      excludedText.push(history.record.responseText);
  }
  const baseline = npc.baselineProfile;
  return {
    sections: {
      worldAndGameSystem: {
        name: bundle.world.name,
        systemType: bundle.world.systemType,
        gameSystem:
          bundle.gameProfile?.npcId === npcId
            ? bundle.gameProfile.gameSystem
            : null,
      },
      persona: {
        name: npc.canonicalName,
        identity: pick(baseline.identity, ["name", "species", "role"]),
        summary: typeof baseline.summary === "string" ? baseline.summary : null,
        personality: pick(baseline.personality, ["traits", "values"]),
        characteristics:
          bundle.gameProfile?.npcId === npcId
            ? bundle.gameProfile.characteristics
            : null,
      },
      currentNpcState: {
        physical: pick(state.physicalState, ["summary"]),
        emotional: pick(state.emotionalState, ["summary"]),
      },
      permittedKnowledge: beliefs,
      permittedMemories: [],
      relevantRelationships: [],
      sceneHistory: [],
      currentSceneAndInteraction: {
        contextType: context.contextType,
        requester: requester
          ? { identity: "withheld_no_recognition_evidence" }
          : null,
        requestText: interaction.requestText,
        interactionType: interaction.interactionType,
      },
      temporalAndPresence: {
        gameTime: null,
        sceneChronology: "unknown",
        parallelScenes: "not_sequenced",
        historicalPresence: "not_established",
        remoteReachability: "not_established",
        currentCommunication:
          "explicit_local_mode_with_stored_location_evidence",
      },
      missing: [
        "history_perception_unproven",
        "memory_disclosure_unclassified",
        "relationship_disclosure_unclassified",
        ...(requester ? [] : ["speaker_unknown"]),
      ],
    },
    excludedText,
    omissions: {
      history: bundle.history.length,
      knowledgeGroups: omittedKnowledge,
      memories: bundle.memories.length,
      relationships: bundle.relationships.length,
    },
  };
}
