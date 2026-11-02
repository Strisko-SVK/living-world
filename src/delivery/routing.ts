import type { DeliveryScope } from "./contracts.js";
export interface RouteCandidate {
  id: string;
  worldId: string;
  contextId: string;
  guildId: string;
  channelId: string;
  threadId: string | null;
  status: string;
  mappingType: string;
  worldActive: boolean;
}
export function resolveOriginalRoute(
  scope: DeliveryScope,
  contextId: string,
  original: {
    guildId: string;
    channelId: string;
    threadId: string | null;
    mappingId: string;
  },
  rows: RouteCandidate[],
): boolean {
  const matching = rows.filter(
    (r) =>
      r.worldActive &&
      r.status === "active" &&
      r.guildId === original.guildId &&
      r.channelId === original.channelId &&
      (r.threadId === null || r.threadId === original.threadId),
  );
  if (
    new Set(matching.map((r) => r.worldId)).size !== 1 ||
    matching[0]?.worldId !== scope.worldId
  )
    return false;
  const exact = original.threadId
    ? matching.filter((r) => r.threadId === original.threadId)
    : [];
  const selected = exact.length
    ? exact
    : matching.filter((r) => r.threadId === null);
  return (
    selected.length === 1 &&
    selected[0].id === original.mappingId &&
    selected[0].contextId === contextId &&
    selected[0].mappingType === "scene"
  );
}
