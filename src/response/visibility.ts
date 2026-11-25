import {
  quartermasterWorldPrefix,
  quartermasterKnowledgeRef,
  quartermasterMemoryRef,
} from "../admin/quartermaster-profile.js";
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
    !interaction.localPresenceId ||
    interaction.localPresenceId !== expected.localPresenceId ||
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
    context.contextType !== "scene" ||
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
  const excludedText: string[] = [];
  const permittedKnowledge = [];
  const legacyWorld = new RegExp(
    "^" + quartermasterWorldPrefix + "[1-9][0-9]{16,19}$",
    "u",
  ).test(bundle.world.key);
  const nativeWorld =
    expected.discordNativeSource &&
    /^lw-dev-discord-[1-9][0-9]{16,19}$/u.test(bundle.world.key);
  const quartermaster =
    bundle.world.systemType === "test" &&
    (legacyWorld || nativeWorld) &&
    npc.canonicalName === "Marcus Voss";
  // Only a native, authenticated, same-player and first-party-tagged turn may
  // make a subjective report/recollection available to that very player.
  // Ordinary 'heard' provenance, public labels and arbitrary imports are NOT
  // sufficient exposure evidence. Never promote a reported claim to truth.
  const turnMarker = /^living-world-native-turn:[0-9a-f]{8}-[0-9a-f-]{27,}$/u;
  const ownTurn = (source: {
    sourceEntityId?: string | null;
    sourceInteractionId?: string | null;
    sourceId?: string | null;
    externalRef?: string | null;
    provenanceNote?: string | null;
  }) =>
    nativeWorld &&
    !!requester &&
    source.sourceEntityId === requester.id &&
    source.provenanceNote === "living-world-native-player-verified-v1" &&
    turnMarker.test(source.sourceId ?? source.externalRef ?? "") &&
    (!source.sourceInteractionId ||
      (source.sourceId ?? "").endsWith(source.sourceInteractionId));
  const eligibleProvenance = (value: {
    total: number;
    omitted: number;
    unavailable: number;
    sources: unknown[];
  }) =>
    value.total === 1 &&
    value.omitted === 0 &&
    value.unavailable === 0 &&
    value.sources.length === 1;
  // Ordinary provenance does not authorize disclosure. This explicitly
  // authored source marker opts public synthetic fixture claims into speech.
  for (const group of bundle.knowledge) {
    for (const { record, provenance } of group.claims) {
      if (
        quartermaster &&
        permittedKnowledge.length < 6 &&
        !group.conflicts.length &&
        group.claims.length === 1 &&
        record.worldId === worldId &&
        record.npcId === npcId &&
        record.status === "current" &&
        record.secrecy === "public" &&
        provenance.total === 1 &&
        provenance.unavailable === 0 &&
        provenance.omitted === 0 &&
        provenance.sources[0]?.sourceType === "dm" &&
        provenance.sources[0].externalRef === quartermasterKnowledgeRef
      ) {
        const statement = record.claimText.split(" [Topics: ")[0];
        permittedKnowledge.push({
          kind:
            record.classification === "fact"
              ? record.predicate === "observation"
                ? "npc_observation"
                : "fixture_fact"
              : record.classification,
          statement,
        });
      } else if (
        permittedKnowledge.length < 6 &&
        group.conflicts.length === 0 &&
        group.claims.length === 1 &&
        record.worldId === worldId &&
        record.npcId === npcId &&
        record.status === "current" &&
        record.secrecy === "public" &&
        record.classification === "reported_claim" &&
        record.subjectEntityId === requester?.id &&
        eligibleProvenance(provenance) &&
        provenance.sources[0]?.sourceType === "heard" &&
        provenance.sources[0]?.sourceMemoryId === null &&
        provenance.sources[0]?.sourceKnowledgeId === null &&
        ownTurn(provenance.sources[0])
      ) {
        permittedKnowledge.push({
          kind: "attributed_player_report_not_verified",
          statement: record.claimText.slice(0, 600),
        });
      } else {
        excludedText.push(record.claimText);
      }
    }
  }
  // A personal recollection is eligible only with a fixture-authored
  // disclosure marker. Ordinary NPC memory and relationship notes stay private.
  const permittedMemories = [];
  for (const { record, provenance } of bundle.memories) {
    if (
      quartermaster &&
      permittedMemories.length < 3 &&
      record.worldId === worldId &&
      record.npcId === npcId &&
      record.status === "active" &&
      provenance.total === 1 &&
      provenance.unavailable === 0 &&
      provenance.omitted === 0 &&
      provenance.sources[0]?.sourceType === "dm" &&
      provenance.sources[0].sourceId === quartermasterMemoryRef
    )
      permittedMemories.push({
        kind: "npc_recollection",
        summary: record.summary.split(" [Topics: ")[0],
      });
    else if (
      permittedMemories.length < 5 &&
      record.worldId === worldId &&
      record.npcId === npcId &&
      record.status === "active" &&
      eligibleProvenance(provenance) &&
      provenance.sources[0]?.sourceType === "interaction" &&
      provenance.sources[0]?.sourceInteractionId !== null &&
      ownTurn(provenance.sources[0])
    ) {
      permittedMemories.push({
        kind: "npc_personal_recollection_attributed",
        summary: record.summary.slice(0, 600),
      });
    } else excludedText.push(record.summary);
  }
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
      permittedKnowledge,
      permittedMemories,
      relevantRelationships:
        nativeWorld && requester
          ? bundle.relationships
              .filter(
                ({ record, participant }) =>
                  record.worldId === worldId &&
                  record.sourceEntityId === npcId &&
                  record.targetEntityId === requester.id &&
                  participant.id === requester.id &&
                  participant.worldId === worldId,
              )
              .slice(0, 1)
              .map(({ record }) => ({
                familiarity: record.familiarity,
                trust: record.trust,
                respect: record.respect,
                affection: record.affection,
                resentment: record.resentment,
              }))
          : [],
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
        ...(permittedKnowledge.length ? [] : ["knowledge_exposure_unproven"]),
        "history_perception_unproven",
        ...(permittedMemories.length ? [] : ["memory_disclosure_unclassified"]),
        ...(nativeWorld ? [] : ["relationship_disclosure_unclassified"]),
        ...(requester ? [] : ["speaker_unknown"]),
      ],
    },
    excludedText,
    omissions: {
      history: bundle.history.length,
      knowledgeGroups: bundle.knowledge.length - permittedKnowledge.length,
      memories: bundle.memories.length - permittedMemories.length,
      relationships: bundle.relationships.length,
    },
  };
}
