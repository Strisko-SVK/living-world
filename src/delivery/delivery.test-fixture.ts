import { vi } from "vitest";
import type {
  DeliveryTransport,
  TransportResult,
  DeliveryAcknowledgement,
} from "./contracts.js";
export type SendRequest = Parameters<DeliveryTransport["send"]>[0];
export function fakeAcknowledgement(
  request: SendRequest,
  messageId = "fake:verified-ack",
): DeliveryAcknowledgement {
  return {
    attemptId: request.attemptId,
    fingerprint: request.fingerprint,
    destination: structuredClone(request.payload.destination),
    messageId,
  };
}
// Test-only, explicitly allowlisted UUID fixture worlds. Never import into runtime.
export function fakeDeliveryTransport(
  worlds: ReadonlySet<string>,
  handler?: (request: SendRequest) => Promise<TransportResult>,
) {
  const sent: SendRequest[] = [];
  const send = vi.fn(async (request: SendRequest): Promise<TransportResult> => {
    if (
      process.env.NODE_ENV !== "test" ||
      !worlds.has(request.payload.scope.worldId)
    )
      throw Error("Isolated delivery test fixture required.");
    sent.push(structuredClone(request));
    return handler
      ? handler(request)
      : { kind: "acknowledged", ack: fakeAcknowledgement(request) };
  });
  return { send, sent };
}
