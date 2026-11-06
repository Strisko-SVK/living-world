import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import {
  entities,
  interactionContexts,
  npcState,
  npcs,
  worlds,
} from "../db/schema/index.js";
import type { SummonFacts } from "./summon-availability.js";

type Database = Omit<DatabaseClient["db"], "$client">;

// Internal read-only projection. It cannot infer physical activity, hearing or
// competing-scene occupancy from free-text summaries, so these remain unknown.
// It confers neither player access nor permission to reveal NPC whereabouts.
export async function readNpcSummonFacts(
  database: Database,
  scope: { worldId: string; npcId: string; contextId: string },
): Promise<SummonFacts | null> {
  const [row] = await database
    .select({
      worldStatus: worlds.status,
      npcStatus: entities.status,
      npcLifecycle: npcs.lifecycleState,
      contextStatus: interactionContexts.status,
      contextType: interactionContexts.contextType,
      sceneLocationId: interactionContexts.linkedLocationEntityId,
      npcLocationId: npcState.currentLocationId,
      locationCertainty: npcState.locationCertainty,
      stateVersion: npcState.version,
    })
    .from(worlds)
    .innerJoin(
      entities,
      and(
        eq(entities.worldId, worlds.id),
        eq(entities.id, scope.npcId),
        eq(entities.entityType, "npc"),
      ),
    )
    .innerJoin(npcs, eq(npcs.entityId, entities.id))
    .innerJoin(npcState, eq(npcState.npcId, npcs.entityId))
    .innerJoin(
      interactionContexts,
      and(
        eq(interactionContexts.worldId, worlds.id),
        eq(interactionContexts.id, scope.contextId),
      ),
    )
    .where(eq(worlds.id, scope.worldId))
    .limit(1);
  return row
    ? {
        ...row,
        activity: "unknown",
        perception: "unknown",
        otherScene: "unknown",
      }
    : null;
}
