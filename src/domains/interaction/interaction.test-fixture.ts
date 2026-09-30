import type { CreateInteractionInput } from "./interaction.validation.js";

export const peloInteractionFixture: Omit<
  CreateInteractionInput,
  "contextId" | "speakerEntityId"
> = {
  interactionType: "direct_question",
  communicationMode: "remote",
  requestText: "Check the docking manifest for the Vertice Fulminate.",
};

export const peloInteractionResponseFixture = {
  responseText: "The manifest lists ten cargo crates.",
};
