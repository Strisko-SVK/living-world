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
  it.each([
    "",
    " ",
    " padded",
    "two words",
    "line\nbreak",
    "nul\u0000byte",
    "x".repeat(2001),
  ])("rejects malformed message provenance %j", (reference) => {
    expect(
      createInteractionInputSchema.safeParse({
        ...interactionInput,
        sourceMessageId: reference,
      }).success,
    ).toBe(false);
    expect(
      recordInteractionResponseInputSchema.safeParse({
        responseText: "ok",
        responseMessageId: reference,
      }).success,
    ).toBe(false);
  });

  it("preserves opaque message IDs and does not invent absent references", () => {
    const sourceMessageId = "00012345678901234567890:opaque-ID";
    expect(
      createInteractionInputSchema.parse({
        ...interactionInput,
        sourceMessageId,
      }).sourceMessageId,
    ).toBe(sourceMessageId);
    expect(
      createInteractionInputSchema.parse(interactionInput).sourceMessageId,
    ).toBeUndefined();
    expect(
      recordInteractionResponseInputSchema.parse({ responseText: "ok" })
        .responseMessageId,
    ).toBeUndefined();
  });

  it("rejects incomplete context provenance", () => {
    expect(
      createInteractionContextInputSchema.safeParse({
        ...contextInput,
        externalChannelId: "channel",
      }).success,
    ).toBe(false);
    expect(
      createInteractionContextInputSchema.safeParse({
        ...contextInput,
        externalProvider: "discord",
        externalThreadId: "thread",
      }).success,
    ).toBe(false);
  });
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
