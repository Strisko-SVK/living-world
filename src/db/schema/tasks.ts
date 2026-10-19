import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { entities } from "./entities.js";
import { interactionContexts } from "./interaction-contexts.js";
import { interactions } from "./interactions.js";
import { taskStatus, taskUrgency } from "./enums.js";
import { worlds } from "./worlds.js";

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    worldId: uuid("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "restrict" }),
    assigneeEntityId: uuid("assignee_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "restrict" }),
    requesterEntityId: uuid("requester_entity_id").references(
      () => entities.id,
      { onDelete: "restrict" },
    ),
    originInteractionId: uuid("origin_interaction_id").references(
      () => interactions.id,
      { onDelete: "restrict" },
    ),
    originContextId: uuid("origin_context_id").references(
      () => interactionContexts.id,
      { onDelete: "restrict" },
    ),
    objective: text("objective").notNull(),
    status: taskStatus("status").notNull().default("proposed"),
    urgency: taskUrgency("urgency").notNull().default("normal"),
    temporalRequirement: text("temporal_requirement"),
    blockedReason: text("blocked_reason"),
    resultSummary: text("result_summary"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "task_assignee_world_fk",
      columns: [table.worldId, table.assigneeEntityId],
      foreignColumns: [entities.worldId, entities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_requester_world_fk",
      columns: [table.worldId, table.requesterEntityId],
      foreignColumns: [entities.worldId, entities.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_interaction_world_fk",
      columns: [table.worldId, table.originInteractionId],
      foreignColumns: [interactions.worldId, interactions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_context_world_fk",
      columns: [table.worldId, table.originContextId],
      foreignColumns: [interactionContexts.worldId, interactionContexts.id],
    }).onDelete("restrict"),
    index("tasks_world_assignee_idx").on(table.worldId, table.assigneeEntityId),
    index("tasks_world_requester_idx").on(
      table.worldId,
      table.requesterEntityId,
    ),
    index("tasks_world_status_idx").on(table.worldId, table.status),
  ],
);
