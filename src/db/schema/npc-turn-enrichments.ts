import { sql } from "drizzle-orm";
import {
  check, index, integer, jsonb, pgTable, text, timestamp, uuid,
} from "drizzle-orm/pg-core";
import { interactions } from "./interactions.js";
import { npcs } from "./npcs.js";
import { worlds } from "./worlds.js";

export const npcTurnEnrichments = pgTable(
  "npc_turn_enrichments",
  {
    interactionId: uuid("interaction_id").primaryKey().references(() => interactions.id, { onDelete: "restrict" }),
    worldId: uuid("world_id").notNull().references(() => worlds.id, { onDelete: "restrict" }),
    npcId: uuid("npc_id").notNull().references(() => npcs.entityId, { onDelete: "restrict" }),
    status: text("status", {enum:["pending","claimed","extracted","applying","done","failed"]}).notNull().default("pending"),
    proposals: jsonb("proposals").$type<unknown>(),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at",{withTimezone:true}),
    lastError: text("last_error"),
    createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
    finishedAt: timestamp("finished_at",{withTimezone:true}),
  },
  (t) => [
    index("npc_turn_enrichments_pending_idx").on(t.status,t.createdAt),
    check("npc_turn_enrichments_status_check",sql`${t.status} in ('pending','claimed','extracted','applying','done','failed')`),
    check("npc_turn_enrichments_attempts_check",sql`${t.attempts} between 0 and 6`),
  ],
);
