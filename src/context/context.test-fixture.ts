import { vi } from "vitest";
import type {
  ContextReader,
  Entity,
  Interaction,
  Knowledge,
  Memory,
  NpcSnapshot,
  Relationship,
} from "./context.types.js";

export const ids = {
  world: "00000000-0000-4000-8000-000000000001",
  npc: "00000000-0000-4000-8000-000000000002",
  speaker: "00000000-0000-4000-8000-000000000003",
  scene: "00000000-0000-4000-8000-000000000004",
  interaction: "00000000-0000-4000-8000-000000000005",
  foreign: "00000000-0000-4000-8000-000000000006",
  otherNpc: "00000000-0000-4000-8000-000000000007",
  otherScene: "00000000-0000-4000-8000-000000000008",
};
export const date = new Date("2026-01-01T00:00:00Z");
export const currentDate = new Date("2026-01-02T00:00:00Z");
export function entity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: ids.speaker,
    worldId: ids.world,
    entityType: "player_character",
    canonicalName: "Garak",
    status: "active",
    createdAt: date,
    updatedAt: date,
    ...overrides,
  };
}
export function interaction(overrides: Partial<Interaction> = {}): Interaction {
  return {
    id: ids.interaction,
    worldId: ids.world,
    npcId: ids.npc,
    contextId: ids.scene,
    speakerEntityId: ids.speaker,
    interactionType: "social",
    intentType: null,
    communicationMode: "unknown",
    requestText: "Check the docking manifest",
    responseText: null,
    status: "received",
    sourceProvider: null,
    sourceMessageId: null,
    responseMessageId: null,
    traceId: ids.interaction,
    createdAt: currentDate,
    respondedAt: null,
    completedAt: null,
    ...overrides,
  };
}
export function knowledge(overrides: Partial<Knowledge> = {}): Knowledge {
  return {
    id: "claim-a",
    worldId: ids.world,
    npcId: ids.npc,
    subjectEntityId: ids.speaker,
    objectEntityId: null,
    predicate: null,
    objectValue: null,
    claimText: "The docking manifest is correct",
    classification: "reported_claim",
    confidence: 0.4,
    secrecy: "private",
    status: "current",
    acquiredAt: null,
    createdAt: date,
    updatedAt: date,
    ...overrides,
  };
}
export function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "memory-a",
    worldId: ids.world,
    npcId: ids.npc,
    memoryType: "episodic",
    summary: "I checked the docking manifest",
    importance: 50,
    detailLevel: "high",
    retentionClass: "normal",
    status: "active",
    emotionalTags: [],
    occurredAt: null,
    createdAt: date,
    updatedAt: date,
    ...overrides,
  };
}
export function relationship(
  overrides: Partial<Relationship> = {},
): Relationship {
  return {
    id: "relationship-a",
    worldId: ids.world,
    sourceEntityId: ids.npc,
    targetEntityId: ids.speaker,
    familiarity: 10,
    trust: 50,
    respect: 50,
    affection: 0,
    fear: 0,
    resentment: 0,
    dependence: 0,
    obligation: 0,
    intent: null,
    utility: null,
    version: 1,
    createdAt: date,
    updatedAt: date,
    ...overrides,
  };
}
export function readerFixture(): ContextReader {
  const npc: NpcSnapshot = {
    npc: {
      ...entity({ id: ids.npc, entityType: "npc", canonicalName: "Pelo" }),
      entityId: ids.npc,
      baselineProfile: { summary: "An analyst" },
      simulationDepth: 3,
      narrativeWeight: 22,
      lifecycleState: "active",
      canonProtected: false,
      templateVersion: 1,
      profileVersion: 1,
    },
    state: {
      npcId: ids.npc,
      currentLocationId: null,
      locationCertainty: "unknown",
      physicalState: {},
      emotionalState: {},
      materialState: {},
      availabilityState: {},
      version: 1,
      updatedAt: date,
    },
  };
  return {
    world: vi.fn().mockResolvedValue({
      id: ids.world,
      key: "test",
      name: "Test World",
      systemType: "test",
      status: "active",
      config: {},
      createdAt: date,
      updatedAt: date,
    }),
    npc: vi.fn().mockResolvedValue(npc),
    gameProfile: vi.fn().mockResolvedValue(null),
    capabilities: vi.fn().mockResolvedValue([]),
    entity: vi.fn().mockImplementation(async (_world, id) => entity({ id })),
    interaction: vi.fn().mockResolvedValue(interaction()),
    context: vi.fn().mockResolvedValue({
      id: ids.scene,
      worldId: ids.world,
      contextType: "scene",
      status: "active",
      linkedLocationEntityId: null,
      externalProvider: null,
      externalGuildId: null,
      externalChannelId: null,
      externalThreadId: null,
      metadata: null,
      createdAt: date,
      updatedAt: date,
    }),
    history: vi.fn().mockResolvedValue([]),
    knowledge: vi.fn().mockResolvedValue([]),
    knowledgeSources: vi.fn().mockResolvedValue([]),
    conflicts: vi.fn().mockResolvedValue([]),
    memories: vi.fn().mockResolvedValue([]),
    memorySources: vi.fn().mockResolvedValue([]),
    relationships: vi.fn().mockResolvedValue([]),
  };
}
