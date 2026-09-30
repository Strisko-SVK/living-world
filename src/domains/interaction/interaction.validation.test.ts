import { describe, expect, it } from "vitest";

import { assertInteractionTransition } from "./interaction.repository.js";
import {
  createInteractionContextInputSchema,
  createInteractionInputSchema,
  recordInteractionResponseInputSchema,
} from "./interaction.validation.js";

const contextInput = { contextType: "direct" as const };
const interactionInput = {
  contextId: "7d444ea9-18af-4a0e-8a66-1fa7994453df",
  interactionType: "direct_question" as const,
  communicationMode: "remote" as const,
  requestText: "Check the docking manifest.",
};

describe("interaction validation", () => {
  it("accepts transport-neutral context and interaction inputs", () => {
    expect(
      createInteractionContextInputSchema.parse(contextInput),
    ).toMatchObject({
      status: "active",
    });
    expect(createInteractionInputSchema.parse(interactionInput)).toMatchObject({
      ...interactionInput,
    });
  });

  it("rejects empty requests, invalid types and communication modes", () => {
    expect(() =>
      createInteractionInputSchema.parse({
        ...interactionInput,
        requestText: " ",
      }),
    ).toThrow();
    expect(() =>
      createInteractionInputSchema.parse({
        ...interactionInput,
        interactionType: "unknown",
      }),
    ).toThrow();
    expect(() =>
      createInteractionInputSchema.parse({
        ...interactionInput,
        communicationMode: "present",
      }),
    ).toThrow();
  });

  it("rejects invalid context statuses and supplied external identifiers", () => {
    expect(() =>
      createInteractionContextInputSchema.parse({
        ...contextInput,
        status: "waiting",
      }),
    ).toThrow();
    expect(() =>
      createInteractionContextInputSchema.parse({
        ...contextInput,
        externalChannelId: " ",
      }),
    ).toThrow();
  });

  it("requires valid IDs and non-empty response text", () => {
    expect(() =>
      createInteractionInputSchema.parse({
        ...interactionInput,
        traceId: "not-a-uuid",
      }),
    ).toThrow();
    expect(() =>
      recordInteractionResponseInputSchema.parse({ responseText: " " }),
    ).toThrow();
    expect(
      recordInteractionResponseInputSchema.parse({
        responseText: "Confirmed.",
      }),
    ).toMatchObject({ responseText: "Confirmed." });
  });

  it("allows only deterministic lifecycle transitions", () => {
    expect(() =>
      assertInteractionTransition("received", "processing"),
    ).not.toThrow();
    expect(() =>
      assertInteractionTransition("received", "responded"),
    ).not.toThrow();
    expect(() =>
      assertInteractionTransition("processing", "failed"),
    ).not.toThrow();
    expect(() =>
      assertInteractionTransition("responded", "completed"),
    ).not.toThrow();
    expect(() =>
      assertInteractionTransition("completed", "responded"),
    ).toThrow();
    expect(() => assertInteractionTransition("failed", "processing")).toThrow();
    expect(() =>
      assertInteractionTransition("responded", "processing"),
    ).toThrow();
  });
});
