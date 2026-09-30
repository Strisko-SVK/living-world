import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { entities } from "./entities.js";
import { interactionContexts } from "./interaction-contexts.js";
import { taskReportDeliveryStatus, taskReportType } from "./enums.js";
import { tasks } from "./tasks.js";

export const taskReports = pgTable(
  "task_reports",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    recipientEntityId: uuid("recipient_entity_id").references(
      () => entities.id,
      { onDelete: "restrict" },
    ),
    contextId: uuid("context_id").references(() => interactionContexts.id, {
      onDelete: "restrict",
    }),
    reportType: taskReportType("report_type").notNull(),
    reportText: text("report_text").notNull(),
    deliveryStatus: taskReportDeliveryStatus("delivery_status")
      .notNull()
      .default("pending"),
    externalMessageId: text("external_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [index("task_reports_task_id_idx").on(table.taskId)],
);
