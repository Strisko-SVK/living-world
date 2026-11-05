import { describe, expect, it, vi } from "vitest";
import {
  createOfflineNpcWorkflow,
  type OfflineInteraction,
  type OfflineWorkflowDependencies,
} from "./npc-e2e.js";
import type { ResponseScope } from "../response/contracts.js";

const worldId = "11111111-1111-4111-8111-111111111111";
const npcId = "22222222-2222-4222-8222-222222222222";
const interactionId = "33333333-3333-4333-8333-333333333333";
const scope: ResponseScope = { worldId, npcId, interactionId };
const row: OfflineInteraction = {
  worldId,
  npcId,
  id: interactionId,
  contextId: "44444444-4444-4444-8444-444444444444",
  status: "received",
  communicationMode: "local",
  sourceProvider: "discord",
  sourceGuildId: "123",
  sourceChannelId: "456",
  sourceMappingId: "555",
  sourceThreadId: "777",
  sourceMessageId: "888",
  localPresenceId: "66666666-6666-4666-8666-666666666666",
};
function fixture(overrides: Partial<OfflineInteraction> = {}) {
  let current = { ...row, ...overrides };
  const read = vi.fn(async () => ({ ...current }));
  const generate = vi.fn(async () => {
    current = { ...current, status: "responded" };
    return {
      ok: true as const,
      status: "responded" as const,
      // Coordinator never accesses generated speech or this opaque interaction.
      interaction: current as never,
      promptVersion: "npc-speech-v1",
    };
  });
  const deliver = vi.fn(async () => "delivered" as const);
  const deps: OfflineWorkflowDependencies = { read, generate, deliver };
  return {
    deps,
    read,
    generate,
    deliver,
    setRow: (next: OfflineInteraction) => {
      current = next;
    },
  };
}
describe("M2.12 offline NPC workflow", () => {
  it("cannot execute the offline coordinator in production mode", async () => {
    const f = fixture();
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(await createOfflineNpcWorkflow(f.deps)(scope)).toBe("offline_only");
      expect(f.read).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.deliver).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("chains an eligible fake-generated response to fake delivery once", async () => {
    const f = fixture();
    expect(await createOfflineNpcWorkflow(f.deps)(scope)).toBe("delivered");
    expect(f.generate).toHaveBeenCalledExactlyOnceWith(scope);
    expect(f.deliver).toHaveBeenCalledExactlyOnceWith(scope);
  });
  it("rejects unprepared unknown communication without side effects", async () => {
    const f = fixture({ communicationMode: "unknown" });
    expect(await createOfflineNpcWorkflow(f.deps)(scope)).toBe("ineligible");
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("rejects invalid UUID before accessing dependencies", async () => {
    const f = fixture();
    expect(
      await createOfflineNpcWorkflow(f.deps)({ ...scope, worldId: "bad" }),
    ).toBe("invalid_scope");
    expect(f.read).not.toHaveBeenCalled();
  });
  it("does not generate or deliver a consumed interaction on replay", async () => {
    const f = fixture({ status: "responded" });
    expect(await createOfflineNpcWorkflow(f.deps)(scope)).toBe("ineligible");
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("never delivers if the response pipeline blocks", async () => {
    const f = fixture();
    f.generate.mockImplementationOnce(
      async () => ({ ok: false, error: "visibility_blocked" }) as never,
    );
    expect(await createOfflineNpcWorkflow(f.deps)(scope)).toBe(
      "response_blocked",
    );
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("fails closed when the original route changes before delivery", async () => {
    const f = fixture();
    f.generate.mockImplementationOnce(async () => {
      f.setRow({ ...row, status: "responded", sourceChannelId: "999" });
      return { ok: true, status: "responded" } as never;
    });
    expect(await createOfflineNpcWorkflow(f.deps)(scope)).toBe("route_changed");
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("blocks delivery on source message or thread substitution", async () => {
    const f = fixture();
    f.generate.mockImplementationOnce(async () => {
      f.setRow({ ...row, status: "responded", sourceThreadId: "999" });
      return { ok: true, status: "responded" } as never;
    });
    expect(await createOfflineNpcWorkflow(f.deps)(scope)).toBe("route_changed");
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it.each([
    ["presence", { localPresenceId: "77777777-7777-4777-8777-777777777777" }],
    ["communication", { communicationMode: "remote" }],
    ["provider", { sourceProvider: "other" }],
  ])(
    "blocks %s substitution between generation and delivery",
    async (_name, change) => {
      const f = fixture();
      f.generate.mockImplementationOnce(async () => {
        f.setRow({ ...row, status: "responded", ...change });
        return { ok: true, status: "responded" } as never;
      });
      expect(await createOfflineNpcWorkflow(f.deps)(scope)).toBe(
        "route_changed",
      );
      expect(f.deliver).not.toHaveBeenCalled();
    },
  );
  it("refuses a local interaction without durable presence evidence", async () => {
    const f = fixture({ localPresenceId: null });
    expect(await createOfflineNpcWorkflow(f.deps)(scope)).toBe("ineligible");
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("classifies thrown generation errors as response failures, never delivery attempts", async () => {
    const f = fixture();
    f.generate.mockRejectedValueOnce(new Error("provider failed"));
    expect(await createOfflineNpcWorkflow(f.deps)(scope)).toBe(
      "response_blocked",
    );
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("does not retry an uncertain delivery", async () => {
    const f = fixture();
    f.deliver.mockImplementationOnce(async () => "uncertain" as never);
    expect(await createOfflineNpcWorkflow(f.deps)(scope)).toBe(
      "delivery_uncertain",
    );
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });
  it("does not attempt a second send after a transport exception", async () => {
    const f = fixture();
    f.deliver.mockRejectedValueOnce(new Error("lost ACK"));
    expect(await createOfflineNpcWorkflow(f.deps)(scope)).toBe(
      "delivery_uncertain",
    );
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });
});
