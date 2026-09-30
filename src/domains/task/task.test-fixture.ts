import type { CreateTaskInput } from "./task.validation.js";

export const peloTaskFixture: Omit<
  CreateTaskInput,
  | "assigneeEntityId"
  | "requesterEntityId"
  | "originInteractionId"
  | "originContextId"
> = {
  objective: "Verify the docking manifest and report any discrepancies.",
  urgency: "normal",
};

export const peloTaskResultFixture = {
  resultSummary: "Manifest lists ten cargo crates.",
};
