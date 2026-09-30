import { randomUUID } from "node:crypto";

import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createDatabaseClient } from "./client.js";
import { entities } from "./schema/entities.js";
import { interactionContexts } from "./schema/interaction-contexts.js";
import { interactions } from "./schema/interactions.js";
import { npcCapabilities } from "./schema/npc-capabilities.js";
import { npcGameProfiles } from "./schema/npc-game-profiles.js";
import { npcState } from "./schema/npc-state.js";
import { npcs } from "./schema/npcs.js";
import { taskReports } from "./schema/task-reports.js";
import { tasks } from "./schema/tasks.js";
import { worlds } from "./schema/worlds.js";
import { createEntity } from "../domains/entity/entity.repository.js";
import {
  createInteraction,
  createInteractionContext,
} from "../domains/interaction/interaction.repository.js";
import { peloInteractionFixture } from "../domains/interaction/interaction.test-fixture.js";
import { createNpc } from "../domains/npc/npc.repository.js";
import { peloNpcFixture } from "../domains/npc/npc.test-fixture.js";
import {
  createTask,
  createTaskReport,
  getTask,
  listTaskReports,
  listTasksForAssignee,
  markTaskReportDelivered,
  transitionTask,
} from "../domains/task/task.repository.js";
import {
  peloTaskFixture,
  peloTaskResultFixture,
} from "../domains/task/task.test-fixture.js";
import { createWorld } from "../domains/world/world.repository.js";

const database = createDatabaseClient();
const worldIds: string[] = [];
const entityIds: string[] = [];
const npcIds: string[] = [];
const contextIds: string[] = [];
const interactionIds: string[] = [];
const taskIds: string[] = [];

afterAll(async () => {
  try {
    if (taskIds.length) {
      await database.db
        .delete(taskReports)
        .where(inArray(taskReports.taskId, taskIds));
      await database.db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
    if (interactionIds.length)
      await database.db
        .delete(interactions)
        .where(inArray(interactions.id, interactionIds));
    if (contextIds.length)
      await database.db
        .delete(interactionContexts)
        .where(inArray(interactionContexts.id, contextIds));
    if (npcIds.length) {
      await database.db
        .delete(npcCapabilities)
        .where(inArray(npcCapabilities.npcId, npcIds));
      await database.db
        .delete(npcGameProfiles)
        .where(inArray(npcGameProfiles.npcId, npcIds));
      await database.db.delete(npcState).where(inArray(npcState.npcId, npcIds));
      await database.db.delete(npcs).where(inArray(npcs.entityId, npcIds));
    }
    if (entityIds.length)
      await database.db.delete(entities).where(inArray(entities.id, entityIds));
    if (worldIds.length)
      await database.db.delete(worlds).where(inArray(worlds.id, worldIds));
  } finally {
    await database.close();
  }
});

describe("task persistence", () => {
  it("persists scoped tasks and separates completion from report delivery", async () => {
    const suffix = randomUUID();
    const worldA = await createWorld(database.db, {
      key: `task-a-${suffix}`,
      name: "Task World A",
      systemType: "test",
    });
    const worldB = await createWorld(database.db, {
      key: `task-b-${suffix}`,
      name: "Task World B",
      systemType: "test",
    });
    worldIds.push(worldA.id, worldB.id);
    const pelo = await createNpc(database.db, worldA.id, peloNpcFixture);
    const severian = await createNpc(database.db, worldA.id, {
      ...peloNpcFixture,
      canonicalName: `Severian ${suffix}`,
    });
    const foreignNpc = await createNpc(database.db, worldB.id, {
      ...peloNpcFixture,
      canonicalName: `Foreign Pel\`o ${suffix}`,
    });
    npcIds.push(pelo.entityId, severian.entityId, foreignNpc.entityId);
    entityIds.push(pelo.entityId, severian.entityId, foreignNpc.entityId);
    const garak = await createEntity(database.db, worldA.id, {
      entityType: "player_character",
      canonicalName: `Garak ${suffix}`,
    });
    const foreignGarak = await createEntity(database.db, worldB.id, {
      entityType: "player_character",
      canonicalName: `Foreign Garak ${suffix}`,
    });
    entityIds.push(garak.id, foreignGarak.id);
    const context = await createInteractionContext(database.db, worldA.id, {
      contextType: "direct",
    });
    const foreignContext = await createInteractionContext(
      database.db,
      worldB.id,
      { contextType: "direct" },
    );
    contextIds.push(context.id, foreignContext.id);
    const origin = await createInteraction(
      database.db,
      worldA.id,
      pelo.entityId,
      {
        ...peloInteractionFixture,
        contextId: context.id,
        speakerEntityId: garak.id,
      },
    );
    const severianInteraction = await createInteraction(
      database.db,
      worldA.id,
      severian.entityId,
      {
        ...peloInteractionFixture,
        contextId: context.id,
        speakerEntityId: garak.id,
      },
    );
    const foreignInteraction = await createInteraction(
      database.db,
      worldB.id,
      foreignNpc.entityId,
      {
        ...peloInteractionFixture,
        contextId: foreignContext.id,
        speakerEntityId: foreignGarak.id,
      },
    );
    interactionIds.push(
      origin!.id,
      severianInteraction!.id,
      foreignInteraction!.id,
    );

    await expect(
      createTask(database.db, worldA.id, {
        ...peloTaskFixture,
        assigneeEntityId: foreignGarak.id,
      }),
    ).rejects.toThrow("Assignee entity was not found");
    await expect(
      createTask(database.db, worldA.id, {
        ...peloTaskFixture,
        assigneeEntityId: pelo.entityId,
        requesterEntityId: foreignGarak.id,
      }),
    ).rejects.toThrow("Requester entity was not found");
    await expect(
      createTask(database.db, worldA.id, {
        ...peloTaskFixture,
        assigneeEntityId: pelo.entityId,
        originContextId: foreignContext.id,
      }),
    ).rejects.toThrow("Origin context was not found");
    await expect(
      createTask(database.db, worldA.id, {
        ...peloTaskFixture,
        assigneeEntityId: pelo.entityId,
        originInteractionId: foreignInteraction!.id,
      }),
    ).rejects.toThrow("Origin interaction was not found");
    await expect(
      createTask(database.db, worldA.id, {
        ...peloTaskFixture,
        assigneeEntityId: pelo.entityId,
        originInteractionId: severianInteraction!.id,
      }),
    ).rejects.toThrow("Origin interaction target does not match");

    const task = await createTask(database.db, worldA.id, {
      ...peloTaskFixture,
      assigneeEntityId: pelo.entityId,
      requesterEntityId: garak.id,
      originInteractionId: origin!.id,
      originContextId: context.id,
    });
    taskIds.push(task.id);
    expect(task).toMatchObject({
      status: "proposed",
      objective: peloTaskFixture.objective,
    });
    await expect(
      getTask(database.db, worldA.id, task.id),
    ).resolves.toMatchObject({ id: task.id });
    await expect(getTask(database.db, worldB.id, task.id)).resolves.toBeNull();
    await expect(
      transitionTask(database.db, worldA.id, task.id, { status: "accepted" }),
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(
      transitionTask(database.db, worldA.id, task.id, { status: "active" }),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      transitionTask(database.db, worldA.id, task.id, {
        status: "blocked",
        blockedReason: "Archive access is pending.",
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      blockedReason: "Archive access is pending.",
    });
    await expect(
      transitionTask(database.db, worldA.id, task.id, { status: "active" }),
    ).resolves.toMatchObject({ status: "active", blockedReason: null });
    const completed = await transitionTask(database.db, worldA.id, task.id, {
      status: "completed",
      ...peloTaskResultFixture,
    });
    expect(completed).toMatchObject({
      status: "completed",
      resultSummary: peloTaskResultFixture.resultSummary,
      completedAt: expect.any(Date),
    });
    await expect(
      transitionTask(database.db, worldA.id, task.id, { status: "active" }),
    ).rejects.toThrow("cannot transition");

    const report = await createTaskReport(database.db, worldA.id, task.id, {
      recipientEntityId: garak.id,
      contextId: context.id,
      reportType: "completion",
      reportText: peloTaskResultFixture.resultSummary,
    });
    expect(report).toMatchObject({ deliveryStatus: "pending" });
    await expect(
      listTaskReports(database.db, worldA.id, task.id),
    ).resolves.toEqual([
      expect.objectContaining({ id: report!.id, deliveryStatus: "pending" }),
    ]);
    await expect(
      listTaskReports(database.db, worldB.id, task.id),
    ).resolves.toEqual([]);
    await expect(
      markTaskReportDelivered(database.db, worldB.id, task.id, report!.id),
    ).resolves.toBeNull();
    await expect(
      markTaskReportDelivered(
        database.db,
        worldA.id,
        task.id,
        report!.id,
        "report-message-1",
      ),
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      externalMessageId: "report-message-1",
      deliveredAt: expect.any(Date),
    });
    await expect(
      listTasksForAssignee(database.db, worldA.id, pelo.entityId, {
        status: "completed",
        urgency: "normal",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: task.id })]);
  });
});
