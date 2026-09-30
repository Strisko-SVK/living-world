import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../../db/client.js";
import { entities } from "../../db/schema/entities.js";
import { interactionContexts } from "../../db/schema/interaction-contexts.js";
import { interactions } from "../../db/schema/interactions.js";
import { npcs } from "../../db/schema/npcs.js";
import { taskReports } from "../../db/schema/task-reports.js";
import { tasks } from "../../db/schema/tasks.js";

import {
  createTaskInputSchema,
  createTaskReportInputSchema,
  listTasksFilterSchema,
  markTaskReportDeliveredInputSchema,
  transitionTaskInputSchema,
  type CreateTaskInput,
  type CreateTaskReportInput,
  type ListTasksFilters,
  type TransitionTaskInput,
} from "./task.validation.js";

type Database = Omit<DatabaseClient["db"], "$client">;
type TaskStatus =
  | "proposed"
  | "accepted"
  | "active"
  | "blocked"
  | "completed"
  | "failed"
  | "abandoned"
  | "cancelled";

const allowedTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  proposed: ["accepted", "cancelled", "abandoned"],
  accepted: ["active", "cancelled", "abandoned"],
  active: ["blocked", "completed", "failed", "cancelled", "abandoned"],
  blocked: ["active", "failed", "cancelled", "abandoned"],
  completed: [],
  failed: [],
  abandoned: [],
  cancelled: [],
};

export function assertTaskTransition(current: TaskStatus, next: TaskStatus) {
  if (!allowedTransitions[current].includes(next)) {
    throw new Error(`Task cannot transition from ${current} to ${next}.`);
  }
}

export async function createTask(
  database: Database,
  worldId: string,
  input: CreateTaskInput,
) {
  const value = createTaskInputSchema.parse(input);
  await assertEntityInWorld(
    database,
    worldId,
    value.assigneeEntityId,
    "Assignee entity",
  );
  if (value.requesterEntityId) {
    await assertEntityInWorld(
      database,
      worldId,
      value.requesterEntityId,
      "Requester entity",
    );
  }
  const originInteraction = value.originInteractionId
    ? await getInteractionInWorld(database, worldId, value.originInteractionId)
    : null;
  if (value.originInteractionId && !originInteraction) {
    throw new Error("Origin interaction was not found in the task's world.");
  }
  if (value.originContextId) {
    const context = await getContextInWorld(
      database,
      worldId,
      value.originContextId,
    );
    if (!context)
      throw new Error("Origin context was not found in the task's world.");
  }
  if (originInteraction && (await isNpc(database, value.assigneeEntityId))) {
    if (originInteraction.npcId !== value.assigneeEntityId) {
      throw new Error(
        "Origin interaction target does not match the NPC task assignee.",
      );
    }
  }
  const [task] = await database
    .insert(tasks)
    .values({ id: randomUUID(), worldId, ...value, status: "proposed" })
    .returning();
  if (!task) throw new Error("Task creation did not return a record.");
  return task;
}

export async function getTask(
  database: Database,
  worldId: string,
  taskId: string,
) {
  const [task] = await database
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.worldId, worldId)))
    .limit(1);
  return task ?? null;
}

export async function listTasksForAssignee(
  database: Database,
  worldId: string,
  assigneeEntityId: string,
  filters?: ListTasksFilters,
) {
  await assertEntityInWorld(
    database,
    worldId,
    assigneeEntityId,
    "Assignee entity",
  );
  return listTasks(
    database,
    worldId,
    eq(tasks.assigneeEntityId, assigneeEntityId),
    filters,
  );
}

export async function listTasksForRequester(
  database: Database,
  worldId: string,
  requesterEntityId: string,
  filters?: ListTasksFilters,
) {
  await assertEntityInWorld(
    database,
    worldId,
    requesterEntityId,
    "Requester entity",
  );
  return listTasks(
    database,
    worldId,
    eq(tasks.requesterEntityId, requesterEntityId),
    filters,
  );
}

export async function transitionTask(
  database: Database,
  worldId: string,
  taskId: string,
  input: TransitionTaskInput,
) {
  const value = transitionTaskInputSchema.parse(input);
  return database.transaction(async (transaction) => {
    const task = await getTask(transaction, worldId, taskId);
    if (!task) return null;
    assertTaskTransition(task.status, value.status);
    const [updated] = await transaction
      .update(tasks)
      .set({
        status: value.status,
        blockedReason: value.status === "blocked" ? value.blockedReason : null,
        resultSummary:
          value.status === "completed"
            ? value.resultSummary
            : task.resultSummary,
        completedAt:
          value.status === "completed" ? new Date() : task.completedAt,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status)))
      .returning();
    if (!updated)
      throw new Error("Task state changed before transition could be applied.");
    return updated;
  });
}

export async function createTaskReport(
  database: Database,
  worldId: string,
  taskId: string,
  input: CreateTaskReportInput,
) {
  const value = createTaskReportInputSchema.parse(input);
  const task = await getTask(database, worldId, taskId);
  if (!task) return null;
  if (value.recipientEntityId) {
    await assertEntityInWorld(
      database,
      worldId,
      value.recipientEntityId,
      "Report recipient entity",
    );
  }
  if (value.contextId) {
    const context = await getContextInWorld(database, worldId, value.contextId);
    if (!context)
      throw new Error("Report context was not found in the task's world.");
  }
  const [report] = await database
    .insert(taskReports)
    .values({ id: randomUUID(), taskId, ...value })
    .returning();
  if (!report) throw new Error("Task report creation did not return a record.");
  return report;
}

export async function listTaskReports(
  database: Database,
  worldId: string,
  taskId: string,
) {
  const task = await getTask(database, worldId, taskId);
  if (!task) return [];
  return database
    .select()
    .from(taskReports)
    .where(eq(taskReports.taskId, taskId))
    .orderBy(asc(taskReports.createdAt), asc(taskReports.id));
}

export async function markTaskReportDelivered(
  database: Database,
  worldId: string,
  taskId: string,
  reportId: string,
  externalMessageId?: string | null,
) {
  const value = markTaskReportDeliveredInputSchema.parse({ externalMessageId });
  const task = await getTask(database, worldId, taskId);
  if (!task) return null;
  const [report] = await database
    .select()
    .from(taskReports)
    .where(and(eq(taskReports.id, reportId), eq(taskReports.taskId, taskId)))
    .limit(1);
  if (!report) return null;
  if (report.deliveryStatus !== "pending") {
    throw new Error("Task report is no longer pending delivery.");
  }
  const [updated] = await database
    .update(taskReports)
    .set({
      deliveryStatus: "delivered",
      externalMessageId: value.externalMessageId,
      deliveredAt: new Date(),
    })
    .where(
      and(
        eq(taskReports.id, reportId),
        eq(taskReports.deliveryStatus, "pending"),
      ),
    )
    .returning();
  if (!updated)
    throw new Error(
      "Task report delivery state changed before it could be updated.",
    );
  return updated;
}

async function listTasks(
  database: Database,
  worldId: string,
  assigneeOrRequesterCondition: ReturnType<typeof eq>,
  filters?: ListTasksFilters,
) {
  const value = listTasksFilterSchema.parse(filters ?? {});
  const conditions = [eq(tasks.worldId, worldId), assigneeOrRequesterCondition];
  if (value.status) conditions.push(eq(tasks.status, value.status));
  if (value.urgency) conditions.push(eq(tasks.urgency, value.urgency));
  return database
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.createdAt), asc(tasks.id));
}

async function assertEntityInWorld(
  database: Database,
  worldId: string,
  entityId: string,
  label: string,
) {
  const [entity] = await database
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.id, entityId), eq(entities.worldId, worldId)))
    .limit(1);
  if (!entity) throw new Error(`${label} was not found in the task's world.`);
}

async function getInteractionInWorld(
  database: Database,
  worldId: string,
  interactionId: string,
) {
  const [interaction] = await database
    .select()
    .from(interactions)
    .where(
      and(
        eq(interactions.id, interactionId),
        eq(interactions.worldId, worldId),
      ),
    )
    .limit(1);
  return interaction ?? null;
}

async function getContextInWorld(
  database: Database,
  worldId: string,
  contextId: string,
) {
  const [context] = await database
    .select({ id: interactionContexts.id })
    .from(interactionContexts)
    .where(
      and(
        eq(interactionContexts.id, contextId),
        eq(interactionContexts.worldId, worldId),
      ),
    )
    .limit(1);
  return context ?? null;
}

async function isNpc(database: Database, entityId: string) {
  const [npc] = await database
    .select({ entityId: npcs.entityId })
    .from(npcs)
    .where(eq(npcs.entityId, entityId))
    .limit(1);
  return Boolean(npc);
}
