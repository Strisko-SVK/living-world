import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
    index("tasks_world_assignee_idx").on(table.worldId, table.assigneeEntityId),
    index("tasks_world_requester_idx").on(
      table.worldId,
      table.requesterEntityId,
    ),
    index("tasks_world_status_idx").on(table.worldId, table.status),
  ],
);
