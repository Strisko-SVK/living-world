import { describe, expect, it } from "vitest";

import { assertTaskTransition } from "./task.repository.js";
import {
  createTaskInputSchema,
  createTaskReportInputSchema,
  taskReportDeliveryStatusSchema,
  transitionTaskInputSchema,
} from "./task.validation.js";

const taskInput = {
  assigneeEntityId: "7d444ea9-18af-4a0e-8a66-1fa7994453df",
  objective: "Verify the manifest.",
};

describe("task validation", () => {
  it("accepts valid task and pending report inputs", () => {
    expect(createTaskInputSchema.parse(taskInput)).toMatchObject({
      urgency: "normal",
    });
    expect(
      createTaskReportInputSchema.parse({
        reportType: "completion",
        reportText: "Done.",
      }),
    ).toMatchObject({ deliveryStatus: "pending" });
  });

  it("rejects empty objectives and invalid urgency", () => {
    expect(() =>
      createTaskInputSchema.parse({ ...taskInput, objective: " " }),
    ).toThrow();
    expect(() =>
      createTaskInputSchema.parse({ ...taskInput, urgency: "immediate" }),
    ).toThrow();
  });

  it("requires explicit blocked reasons and completion results", () => {
    expect(() =>
      transitionTaskInputSchema.parse({ status: "blocked" }),
    ).toThrow();
    expect(() =>
      transitionTaskInputSchema.parse({ status: "completed" }),
    ).toThrow();
    expect(
      transitionTaskInputSchema.parse({
        status: "blocked",
        blockedReason: "Awaiting archive access.",
      }),
    ).toMatchObject({ status: "blocked" });
  });

  it("rejects empty reports and unsupported report or delivery statuses", () => {
    expect(() =>
      createTaskReportInputSchema.parse({
        reportType: "completion",
        reportText: " ",
      }),
    ).toThrow();
    expect(() =>
      createTaskReportInputSchema.parse({
        reportType: "notice",
        reportText: "Done.",
      }),
    ).toThrow();
    expect(() => taskReportDeliveryStatusSchema.parse("queued")).toThrow();
  });

  it("allows only the task lifecycle transition matrix", () => {
    expect(() => assertTaskTransition("proposed", "accepted")).not.toThrow();
    expect(() => assertTaskTransition("accepted", "active")).not.toThrow();
    expect(() => assertTaskTransition("active", "blocked")).not.toThrow();
    expect(() => assertTaskTransition("blocked", "active")).not.toThrow();
    expect(() => assertTaskTransition("active", "completed")).not.toThrow();
    expect(() => assertTaskTransition("completed", "active")).toThrow();
    expect(() => assertTaskTransition("failed", "active")).toThrow();
    expect(() => assertTaskTransition("proposed", "completed")).toThrow();
  });
});
