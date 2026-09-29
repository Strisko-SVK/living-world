import { pgEnum } from "drizzle-orm/pg-core";

export const worldStatusValues = ["active", "archived"] as const;
export const entityStatusValues = ["active", "inactive", "archived"] as const;
export const entityTypeValues = [
  "npc",
  "player_character",
  "location",
  "organization",
  "faction",
  "ship",
  "group",
  "population_node",
  "item",
  "other",
] as const;
export const npcLifecycleStateValues = [
  "active",
  "dormant",
  "travelling",
  "missing",
  "archived",
  "dead",
] as const;
export const locationCertaintyValues = [
  "certain",
  "probable",
  "uncertain",
  "unknown",
] as const;
export const capabilityLevelValues = [
  "untrained",
  "basic",
  "competent",
  "experienced",
  "expert",
] as const;
export const capabilitySourceValues = [
  "profile",
  "game_system",
  "background",
  "manual",
  "derived",
] as const;
export const memoryTypeValues = [
  "episodic",
  "social",
  "emotional",
  "traumatic",
  "achievement",
  "failure",
  "relationship",
  "world_event",
  "routine",
] as const;
export const memoryDetailLevelValues = [
  "high",
  "medium",
  "low",
  "gist",
] as const;
export const memoryRetentionClassValues = [
  "temporary",
  "normal",
  "important",
  "permanent",
] as const;
export const memoryStatusValues = [
  "active",
  "consolidated",
  "archived",
  "invalidated",
] as const;
export const memorySourceTypeValues = [
  "interaction",
  "witnessed",
  "heard",
  "read",
  "official",
  "inferred",
  "archive",
  "dm",
  "system",
  "imported",
] as const;
export const memoryRelationTypeValues = [
  "consolidated_from",
  "summarizes",
  "related_to",
  "contradicts",
  "supersedes",
] as const;
export const knowledgeClassificationValues = [
  "fact",
  "reported_claim",
  "rumor",
  "inference",
  "assumption",
  "misinformation",
] as const;
export const knowledgeSecrecyValues = [
  "public",
  "private",
  "restricted",
  "secret",
] as const;
export const knowledgeStatusValues = [
  "current",
  "outdated",
  "disputed",
  "invalidated",
] as const;
export const knowledgeSourceTypeValues = [
  "witnessed",
  "heard",
  "read",
  "official",
  "inferred",
  "rumor_chain",
  "memory",
  "archive",
  "dm",
  "system",
  "imported",
] as const;
export const knowledgeConflictStatusValues = [
  "unresolved",
  "reviewed",
  "resolved",
] as const;
export const relationshipIntentValues = [
  "genuine",
  "transactional",
  "manipulative",
  "opportunistic",
  "coercive",
  "protective",
  "mixed",
] as const;
export const relationshipEventTypeValues = [
  "interaction",
  "assistance",
  "betrayal",
  "insult",
  "threat",
  "gift",
  "obligation_created",
  "obligation_fulfilled",
  "shared_experience",
  "conflict",
  "reconciliation",
  "dm_adjustment",
  "imported",
  "other",
] as const;

export const worldStatus = pgEnum("world_status", worldStatusValues);
export const entityStatus = pgEnum("entity_status", entityStatusValues);
export const entityType = pgEnum("entity_type", entityTypeValues);
export const npcLifecycleState = pgEnum(
  "npc_lifecycle_state",
  npcLifecycleStateValues,
);
export const locationCertainty = pgEnum(
  "location_certainty",
  locationCertaintyValues,
);
export const capabilityLevel = pgEnum(
  "capability_level",
  capabilityLevelValues,
);
export const capabilitySource = pgEnum(
  "capability_source",
  capabilitySourceValues,
);
export const memoryType = pgEnum("memory_type", memoryTypeValues);
export const memoryDetailLevel = pgEnum(
  "memory_detail_level",
  memoryDetailLevelValues,
);
export const memoryRetentionClass = pgEnum(
  "memory_retention_class",
  memoryRetentionClassValues,
);
export const memoryStatus = pgEnum("memory_status", memoryStatusValues);
export const memorySourceType = pgEnum(
  "memory_source_type",
  memorySourceTypeValues,
);
export const memoryRelationType = pgEnum(
  "memory_relation_type",
  memoryRelationTypeValues,
);
export const knowledgeClassification = pgEnum(
  "knowledge_classification",
  knowledgeClassificationValues,
);
export const knowledgeSecrecy = pgEnum(
  "knowledge_secrecy",
  knowledgeSecrecyValues,
);
export const knowledgeStatus = pgEnum(
  "knowledge_status",
  knowledgeStatusValues,
);
export const knowledgeSourceType = pgEnum(
  "knowledge_source_type",
  knowledgeSourceTypeValues,
);
export const knowledgeConflictStatus = pgEnum(
  "knowledge_conflict_status",
  knowledgeConflictStatusValues,
);
export const relationshipIntent = pgEnum(
  "relationship_intent",
  relationshipIntentValues,
);
export const relationshipEventType = pgEnum(
  "relationship_event_type",
  relationshipEventTypeValues,
);
