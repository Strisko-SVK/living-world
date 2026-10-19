import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { entities } from "./entities.js";
import {
  communicationMode,
  interactionStatus,
  interactionType,
} from "./enums.js";
import { interactionContexts } from "./interaction-contexts.js";
import { npcs } from "./npcs.js";
import { worlds } from "./worlds.js";

export const interactions = pgTable(
  "interactions",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "restrict" }),
    contextId: uuid("context_id")
      .notNull()
      .references(() => interactionContexts.id, { onDelete: "restrict" }),
    npcId: uuid("npc_id")
      .notNull()
      .references(() => npcs.entityId, { onDelete: "restrict" }),
    speakerEntityId: uuid("speaker_entity_id").references(() => entities.id, {
      onDelete: "restrict",
    }),
    interactionType: interactionType("interaction_type").notNull(),
    intentType: interactionType("intent_type"),
    communicationMode: communicationMode("communication_mode").notNull(),
    requestText: text("request_text").notNull(),
    responseText: text("response_text"),
    status: interactionStatus("status").notNull().default("received"),
    sourceMessageId: text("source_message_id"),
    sourceProvider: text("source_provider"),
    responseMessageId: text("response_message_id"),
    traceId: uuid("trace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "interaction_source_provider_message",
      sql`${table.sourceProvider} is null or (${table.sourceMessageId} is not null and length(${table.sourceMessageId}) > 0 and length(${table.sourceProvider}) > 0)`,
    ),
    uniqueIndex("interactions_source_event_npc_unique")
      .on(
        table.worldId,
        table.npcId,
        table.sourceProvider,
        table.sourceMessageId,
      )
      .where(
        sql`${table.sourceProvider} is not null and ${table.sourceMessageId} is not null`,
      ),
    unique("interactions_world_id_unique").on(table.worldId, table.id),
    foreignKey({
      name: "interaction_context_world_fk",
      columns: [table.worldId, table.contextId],
      foreignColumns: [interactionContexts.worldId, interactionContexts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "interaction_npc_world_fk",
      columns: [table.worldId, table.npcId],
      foreignColumns: [entities.worldId, entities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "interaction_speaker_world_fk",
      columns: [table.worldId, table.speakerEntityId],
      foreignColumns: [entities.worldId, entities.id],
    }).onDelete("restrict"),
    index("interactions_world_npc_idx").on(table.worldId, table.npcId),
    index("interactions_world_npc_status_idx").on(
      table.worldId,
      table.npcId,
      table.status,
    ),
    index("interactions_trace_id_idx").on(table.traceId),
  ],
);
