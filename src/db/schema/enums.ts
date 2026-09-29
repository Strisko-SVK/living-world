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
