import { z } from "zod";

import {
  taskReportDeliveryStatusValues,
  taskReportTypeValues,
  taskStatusValues,
  taskUrgencyValues,
} from "../../db/schema/enums.js";

const optionalText = z.string().trim().min(1).max(20_000).nullable().optional();

export const createTaskInputSchema = z.object({
  assigneeEntityId: z.string().uuid(),
  requesterEntityId: z.string().uuid().nullable().optional(),
  originInteractionId: z.string().uuid().nullable().optional(),
  originContextId: z.string().uuid().nullable().optional(),
  objective: z
    .string()
    .trim()
    .min(1, "Task objective is required.")
    .max(20_000),
  urgency: z.enum(taskUrgencyValues).default("normal"),
  temporalRequirement: optionalText,
});

export const transitionTaskInputSchema = z
  .object({
    status: z.enum(taskStatusValues),
    blockedReason: optionalText,
    resultSummary: optionalText,
  })
  .superRefine((value, context) => {
    if (value.status === "blocked" && !value.blockedReason) {
      context.addIssue({
        code: "custom",
        path: ["blockedReason"],
        message: "Blocked tasks require a blocked reason.",
      });
    }
    if (value.status === "completed" && !value.resultSummary) {
      context.addIssue({
        code: "custom",
        path: ["resultSummary"],
        message: "Completed tasks require a result summary.",
      });
    }
  });

export const createTaskReportInputSchema = z.object({
  recipientEntityId: z.string().uuid().nullable().optional(),
  contextId: z.string().uuid().nullable().optional(),
  reportType: z.enum(taskReportTypeValues),
  reportText: z
    .string()
    .trim()
    .min(1, "Task report text is required.")
    .max(20_000),
  deliveryStatus: z.literal("pending").default("pending"),
});

export const markTaskReportDeliveredInputSchema = z.object({
  externalMessageId: z.string().trim().min(1).max(2_000).nullable().optional(),
});

export const listTasksFilterSchema = z.object({
  status: z.enum(taskStatusValues).optional(),
  urgency: z.enum(taskUrgencyValues).optional(),
});

export const taskReportDeliveryStatusSchema = z.enum(
  taskReportDeliveryStatusValues,
);

export type CreateTaskInput = z.input<typeof createTaskInputSchema>;
export type TransitionTaskInput = z.input<typeof transitionTaskInputSchema>;
export type CreateTaskReportInput = z.input<typeof createTaskReportInputSchema>;
export type ListTasksFilters = z.input<typeof listTasksFilterSchema>;
