import type { CreateNpcInput } from "./npc.validation.js";

export const peloNpcFixture: CreateNpcInput = {
  canonicalName: 'Peniel "Pel`o" Suborbulo Amiam',
  simulationDepth: 3,
  narrativeWeight: 22,
  lifecycleState: "active",
  baselineProfile: {
    identity: {
      name: 'Peniel "Pel`o" Suborbulo Amiam',
      species: "Human",
      role: "Administratum analyst",
    },
    summary:
      "An incisive analyst whose physical and combat ability are limited.",
    personality: {
      traits: ["methodical", "cautious"],
      values: ["accuracy", "duty"],
    },
  },
  initialState: {
    locationCertainty: "certain",
    physicalState: { summary: "Physically frail." },
    emotionalState: { summary: "Composed." },
    availabilityState: { summary: "Available for administrative work." },
  },
  gameProfile: {
    gameSystem: "mixed_dh_rt",
    statDepth: 3,
    characteristics: {
      intelligence: "high",
      weaponSkill: "low",
      ballisticSkill: "low",
      strength: "low",
      toughness: "low",
    },
    skills: { logic: "trained", scrutiny: "trained" },
    talents: {},
    combat: { aptitude: "limited" },
    gear: {},
    derivedValues: {},
    sourceNotes: { basis: "test fixture" },
  },
  capabilities: [
    {
      capabilityKey: "bureaucracy",
      level: "expert",
      source: "profile",
      confidence: 0.95,
    },
    {
      capabilityKey: "analytics",
      level: "experienced",
      source: "profile",
      confidence: 0.9,
    },
    {
      capabilityKey: "shooting",
      level: "untrained",
      source: "background",
      confidence: 0.8,
    },
  ],
};
