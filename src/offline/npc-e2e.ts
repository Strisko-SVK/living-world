import { z } from "zod";
import type { ResponseResult, ResponseScope } from "../response/contracts.js";

// Offline-only composition boundary. Not wired to runtime, Discord, HTTP or LLM.
// The existing response pipeline and delivery repository remain authoritative.
const scopeSchema = z
  .object({
    worldId: z.string().uuid(),
    npcId: z.string().uuid(),
    interactionId: z.string().uuid(),
  })
  .strict();

export type OfflineInteraction = {
  worldId: string;
  npcId: string;
  id: string;
  contextId: string;
  status: string;
  communicationMode: string;
  sourceProvider: string | null;
  sourceGuildId: string | null;
  sourceChannelId: string | null;
  sourceMappingId: string | null;
};

export type OfflineWorkflowDependencies = {
  read(scope: ResponseScope): Promise<OfflineInteraction | null>;
  // Must be the existing M2.7 orchestrator with injected fake provider in tests.
  generate(scope: ResponseScope): Promise<ResponseResult>;
  // Must be the existing M2.10 dispatcher with injected fake transport in tests.
  // A successful return means a validated, durable fake ACK, not merely a send attempt.
  deliver(scope: ResponseScope): Promise<"delivered" | "blocked" | "uncertain">;
};

export type OfflineWorkflowResult =
  | "invalid_scope"
  | "not_found"
  | "ineligible"
  | "response_blocked"
  | "route_changed"
  | "delivered"
  | "delivery_blocked"
  | "delivery_uncertain";

export function createOfflineNpcWorkflow(deps: OfflineWorkflowDependencies) {
  return async (scope: ResponseScope): Promise<OfflineWorkflowResult> => {
    if (!scopeSchema.safeParse(scope).success) return "invalid_scope";
    try {
      const before = await deps.read(scope);
      if (!before) return "not_found";
      if (
        before.worldId !== scope.worldId ||
        before.npcId !== scope.npcId ||
        before.id !== scope.interactionId ||
        before.status !== "received" ||
        before.communicationMode !== "local" ||
        before.sourceProvider !== "discord" ||
        !before.sourceGuildId ||
        !before.sourceChannelId ||
        !before.sourceMappingId
      )
        return "ineligible";

      const result = await deps.generate(scope);
      // Never treat an already-recorded response as permission to send again.
      if (!result.ok || result.status !== "responded") return "response_blocked";

      const after = await deps.read(scope);
      if (
        !after ||
        after.worldId !== before.worldId ||
        after.npcId !== before.npcId ||
        after.id !== before.id ||
        after.contextId !== before.contextId ||
        after.sourceGuildId !== before.sourceGuildId ||
        after.sourceChannelId !== before.sourceChannelId ||
        after.sourceMappingId !== before.sourceMappingId ||
        after.status !== "responded"
      )
        return "route_changed";

      const delivery = await deps.deliver(scope);
      return delivery === "delivered"
        ? "delivered"
        : delivery === "uncertain"
          ? "delivery_uncertain"
          : "delivery_blocked";
    } catch {
      // No automatic retry, reconciliation or second send.
      return "delivery_uncertain";
    }
  };
}
