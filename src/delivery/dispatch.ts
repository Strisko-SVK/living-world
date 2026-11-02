import {
  transportResultSchema,
  type DeliveryScope,
  type DeliveryTransport,
} from "./contracts.js";
import type { DeliveryRepository } from "./delivery.repository.js";
// Explicit invocation only. No default transport, timers, runtime imports or polling.
export function createDeliveryDispatcher(
  repository: DeliveryRepository,
  transport: DeliveryTransport,
) {
  return async (scope: DeliveryScope) => {
    const claimed = await repository.claim(scope);
    if (!claimed?.attemptId) return { status: "not_claimed" as const };
    const sending = await repository.preflight(scope, claimed.attemptId);
    if (!sending) return { status: "blocked" as const };
    try {
      const result = transportResultSchema.safeParse(
        await transport.send({
          payload: structuredClone(sending.payload),
          attemptId: claimed.attemptId,
          fingerprint: sending.fingerprint,
        }),
      );
      if (!result.success) {
        await repository.fail(scope, claimed.attemptId, { kind: "uncertain" });
        return { status: "uncertain" as const };
      }
      if (result.data.kind === "acknowledged") {
        if (await repository.acknowledge(scope, result.data.ack))
          return { status: "delivered" as const };
        await repository.fail(scope, claimed.attemptId, { kind: "uncertain" });
        return { status: "uncertain" as const };
      }
      const row = await repository.fail(scope, claimed.attemptId, result.data);
      return { status: row?.status ?? "uncertain" };
    } catch {
      // A throw, including lost persistence acknowledgement, is never proof of no send.
      const row = await repository.recover(scope);
      if (row?.status === "delivered") return { status: "delivered" as const };
      await repository.fail(scope, claimed.attemptId, { kind: "uncertain" });
      return { status: "uncertain" as const };
    }
  };
}
