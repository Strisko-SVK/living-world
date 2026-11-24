import type { DatabaseClient } from "../db/client.js";
import { addEntityAlias } from "../domains/entity/entity.repository.js";
import {
  addMemorySource,
  createMemory,
} from "../domains/memory/memory.repository.js";
import { createNpc } from "../domains/npc/npc.repository.js";
import {
  addKnowledgeSource,
  createKnowledge,
} from "../domains/knowledge/knowledge.repository.js";

export const quartermasterWorldPrefix = "lw-dev-quartermaster-";
export const quartermasterMemoryRef = "quartermaster-dev-public-memory-v1";
export const quartermasterKnowledgeRef = "quartermaster-dev-public-v1";
export const sentinelPresentation = {
  aliases: ["sentinel", "sentinel-001"],
  displayName: "Sentinel-001",
  avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
};
export const quartermasterPresentation = {
  aliases: ["quartermaster", "marcus voss", "voss"],
  displayName: "Marcus Voss",
  avatarUrl: "https://cdn.discordapp.com/embed/avatars/4.png",
};

const ledger = [
  [
    "inventory",
    "stock inventory supplies sklad zásoby vybavenie",
    "After the morning count, the Wayfarer Ledger has 84 water filters, 18 valve kits, 12 med packs, and 240 sealed ration packs.",
  ],
  [
    "reserve",
    "ration food reserves jedlo prídely rezerva",
    "Of the 240 ration packs, 48 are the lifeboat reserve. Voss offers dried apples when the galley can spare them.",
  ],
  [
    "filters",
    "water filter filters purifier voda filtre",
    "Eighty-four filters are on hand. Dock mechanic Irena Vale asked about exchanging six filters for two clean pump seals. This is a proposal only.",
  ],
  [
    "valves",
    "valve valves kits engineering ventily súpravy Harlan",
    "Chief Engineer Harlan requested twelve of the eighteen valve kits after the cooling loop on pump two started leaking. He has yet to collect them.",
  ],
  [
    "shortage",
    "shortage coolant coolantant chladivo nedostatok zásoby",
    "There are six coolant canisters left. Four are reserved for Engineering and two can be negotiated. Voss wants those traded for pump seals.",
  ],
  [
    "medbay",
    "medical med packs medicine medbay lekárka zdravotnícke balíky Sera",
    "Medic Sera Nadir administers the twelve med packs. Routine supplies can be requested at Medbay after second watch.",
  ],
  [
    "delivery",
    "cargo manifest crate blue delivery zásielka náklad debna modrá",
    "A blue crate of pump seals arrived on the last tender. The label says eight. Receiver Niko counted five and logged the discrepancy.",
  ],
  [
    "shipment",
    "delivery shipment ash tender arrival plán zásielka kuriér najbližšia",
    "The Ash Finch tender is due next first watch with twenty coolant canisters. Its departure is confirmed. Arrival depends on customs clearance.",
  ],
  [
    "supplier",
    "supplier invoice merchant trade negotiation supplier obchod zľava výmena Kestrel",
    "Merchant Dax Kestrel overcharged for five couplings on the last invoice. Voss will bargain if the buyer brings a written price and accepts a partial delivery.",
  ],
  [
    "crew",
    "crew relationships posádka vzťahy hľadám",
    "Voss trusts Chief Engineer Harlan, deals cordially with Sera Nadir, dislikes merchant Dax Kestrel, and watches broker Vela Rook closely.",
  ],
  [
    "harbor",
    "broker harbor customs Vela Rook prístav sprostredkovateľka",
    "Broker Vela Rook claims she can expedite customs. Voss is suspicious because she wanted a berth list before offering a price.",
  ],
  [
    "apprentice",
    "history background apprenticeship past career minulosť príbeh začiatky",
    "Voss grew up fixing water pumps in Brinefall, broke his nose on his first cargo shift, and learned bookkeeping from a retired dock clerk.",
  ],
  [
    "storm",
    "storm voyage story history minulosť príhoda búrka plavba",
    "During a dust storm at Calder Reach, Voss kept the pump running with a split gasket and scrap cloth while Harlan rerouted power. They saved the emergency water reserve.",
  ],
  [
    "festival",
    "hobby coffee humour drink oddych káva nápoj záľuby",
    "Voss drinks bitter chicory, plays a terrible game of dice, and names broken pallet jacks after forgetful officers.",
  ],
  [
    "locations",
    "location office cargo deck galley zásobovanie kde kancelária paluba",
    "The Supply Office is on the Cargo Deck beside Lift Three. The galley is one deck above. Pump two is in Engineering aft.",
  ],
  [
    "incident",
    "recent incident damage storm leak incident nehoda škoda priesak",
    "Last second watch a lift jammed. Deckhand Niko pinned a finger, Medbay cleared him for light duty, and Lift Three reopened after inspection.",
  ],
  [
    "belief",
    "broker suspicious suspect podozrenie neverím Vela Rook",
    "Voss suspects Vela might be selling berth lists. He has no proof.",
  ],
  [
    "observation",
    "observation crates smells damage pozorovanie mokré debny",
    "Voss saw two wet crate corners at morning count. He cannot tell whether the moisture was from condensation or the tender's hold.",
  ],
  [
    "deal",
    "trade terms bargain negotiate price coolant barter výmena dohoda cena chladivo",
    "Voss can discuss an indicative exchange of two coolant canisters for one verified clean pump seal each. Approval, allocation and collection are separate.",
  ],
  [
    "unknown",
    "captain coordinates orders sealed manifest kapitán súradnice tajné neznáme",
    "Voss has no verified destination coordinates, captain's private orders, or contents of sealed medical cargo.",
  ],
  [
    "rumour",
    "rumor rumours rumour gossip embargo rumors klebety fámy embargo",
    "A dock runner claims a customs embargo may delay the Ash Finch. Voss has seen no notice and treats it as dock gossip.",
  ],
  [
    "claim",
    "Niko count crate count claim discrepancy Niko počet hlásenie",
    "Niko reported that a broken seal was already visible when the blue crate arrived. Voss has not verified who broke it.",
  ],
] as const;

export async function seedQuartermaster(
  db: Omit<DatabaseClient["db"], "$client">,
  worldId: string,
  locationId: string,
) {
  const npc = await createNpc(db, worldId, {
    canonicalName: quartermasterPresentation.displayName,
    simulationDepth: 2,
    narrativeWeight: 20,
    baselineProfile: {
      identity: {
        name: "Marcus Voss",
        species: "Human",
        role: "Senior Ship Quartermaster",
      },
      summary:
        "Long-serving quartermaster aboard the Wayfarer Ledger. Values practical competence over rank. Protects crew reserves, dislikes waste and paperwork, and can bargain without authorizing transactions.",
      personality: {
        traits: [
          "Pragmatic",
          "Experienced",
          "Dryly sarcastic",
          "Financially minded",
          "Protective",
          "Wary of strangers",
        ],
        values: [
          "Crew welfare",
          "Accurate counts",
          "Fair bargains",
          "Loyalty to the ship",
        ],
      },
      presentation: {
        displayName: quartermasterPresentation.displayName,
        avatarUrl: quartermasterPresentation.avatarUrl,
      },
    },
    initialState: {
      currentLocationId: locationId,
      locationCertainty: "certain",
      physicalState: {
        summary: "At the supply counter, checking a handwritten ledger.",
      },
      emotionalState: {
        summary: "Busy and mildly irritated by the morning paperwork.",
      },
      availabilityState: {
        summary:
          "Available for local conversation and provisional negotiation.",
      },
    },
    gameProfile: { gameSystem: "System-neutral DEV", statDepth: 0 },
    capabilities: [
      {
        capabilityKey: "supply_management",
        level: "experienced",
        source: "profile",
        confidence: 1,
      },
      {
        capabilityKey: "negotiation",
        level: "experienced",
        source: "profile",
        confidence: 1,
      },
      {
        capabilityKey: "local_dialogue",
        level: "competent",
        source: "profile",
        confidence: 1,
      },
    ],
  });
  for (const alias of quartermasterPresentation.aliases)
    await addEntityAlias(db, worldId, npc.entityId, { alias });

  for (const [predicate, cues, claim] of ledger) {
    await seed(
      predicate,
      claim + " [Topics: " + cues + "]",
      predicate === "rumour"
        ? "rumor"
        : predicate === "claim"
          ? "reported_claim"
          : predicate === "belief"
            ? "inference"
            : "fact",
      "public",
    );
  }
  await seed("restricted", "AMBER-HOLD-739", "fact", "restricted");
  await seed("confidential", "COPPER-LEDGER-528", "fact", "secret");
  for (const summary of [
    "Voss remembers learning stock counting from dock clerk Jana. She made him reconcile a handwritten ledger three times after a barrel of salt vanished. [Topics: memory story background upbringing ledger Brinefall príbeh spomienka minulosť]",
    "Voss remembers Harlan silently handing him a mug of chicory after the storm at Calder Reach. It was the first night in a week that both could sleep. [Topics: memory story background storm Harlan chicory príbeh spomienka búrka]",
  ]) {
    const memory = await createMemory(db, worldId, npc.entityId, {
      summary,
      memoryType: "social",
      importance: 65,
      detailLevel: "gist",
      retentionClass: "normal",
    });
    if (
      !memory ||
      !(await addMemorySource(db, worldId, npc.entityId, memory.id, {
        sourceType: "dm",
        sourceId: quartermasterMemoryRef,
      }))
    )
      throw new Error("Quartermaster memory seed failed.");
  }
  return npc.entityId;

  async function seed(
    predicate: string,
    claimText: string,
    classification: "fact" | "rumor" | "reported_claim" | "inference",
    secrecy: "public" | "restricted" | "secret",
  ) {
    const knowledge = await createKnowledge(db, worldId, npc.entityId, {
      subjectEntityId: locationId,
      predicate,
      claimText,
      classification,
      secrecy,
      confidence: classification === "fact" ? 1 : 0.5,
    });
    if (
      !knowledge ||
      !(await addKnowledgeSource(db, worldId, npc.entityId, knowledge.id, {
        sourceType: "dm",
        externalRef:
          secrecy === "public"
            ? quartermasterKnowledgeRef
            : "quartermaster-dev-private-v1",
      }))
    )
      throw new Error("Quartermaster knowledge seed failed.");
  }
}
