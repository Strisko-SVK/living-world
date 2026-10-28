import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextBudgetExceededError,
  ContextUnavailableError,
  createContextBuilder,
  estimateContextBytes,
} from "./context-builder.js";
import {
  date,
  currentDate,
  entity,
  ids,
  interaction,
  knowledge,
  memory,
  readerFixture,
  relationship,
} from "./context.test-fixture.js";
import type { ContextReader } from "./context.types.js";

let reader: ContextReader;
const request = {
  worldId: ids.world,
  npcId: ids.npc,
  interactionId: ids.interaction,
};
beforeEach(() => {
  reader = readerFixture();
});

describe("NPC context builder", () => {
  it("does not retrieve history for inactive contexts", async () => {
    const scene = await reader.context(ids.world, ids.scene);
    vi.mocked(reader.context).mockResolvedValue({
      ...scene!,
      status: "inactive",
    });
    const bundle = await createContextBuilder(reader)(request);
    expect(reader.history).not.toHaveBeenCalled();
    expect(bundle.missing).toContain("origin_context_inactive");
  });

  it("excludes claims with unavailable world-scoped entity references", async () => {
    vi.mocked(reader.knowledge).mockResolvedValue([
      knowledge({ subjectEntityId: ids.foreign }),
    ]);
    vi.mocked(reader.entity).mockImplementation(async (_world, id) =>
      entity({ id, worldId: id === ids.foreign ? ids.foreign : ids.world }),
    );
    const bundle = await createContextBuilder(reader)(request);
    expect(bundle.knowledge).toHaveLength(0);
    expect(bundle.retrieval.categories.knowledge.unavailable).toBe(1);
  });

  it("omits an entire contradictory group when it cannot fit the byte budget", async () => {
    vi.mocked(reader.knowledge).mockResolvedValue([
      knowledge({ claimText: "manifest " + "a".repeat(2000) }),
      knowledge({ id: "claim-b", claimText: "manifest " + "b".repeat(2000) }),
    ]);
    vi.mocked(reader.conflicts).mockResolvedValue([
      {
        id: "conflict",
        worldId: ids.world,
        npcId: ids.npc,
        claimAId: "claim-a",
        claimBId: "claim-b",
        status: "unresolved",
        createdAt: date,
        resolvedAt: null,
        resolutionNote: null,
      },
    ]);
    const essentials = await createContextBuilder(reader)({
      ...request,
      limits: {
        knowledge: 0,
        memories: 0,
        relationships: 0,
        history: 0,
        capabilities: 0,
      },
    });
    const bundle = await createContextBuilder(reader)({
      ...request,
      maxBytes: essentials.budget.estimatedBytes + 300,
    });
    expect(bundle.knowledge).toHaveLength(0);
    expect(bundle.retrieval.categories.knowledge.omittedByBudget).toBe(2);
    expect(estimateContextBytes(bundle)).toBeLessThanOrEqual(
      bundle.budget.maxBytes,
    );
  });

  it("uses scene provenance for memory relevance even when provenance output is capped to zero", async () => {
    vi.mocked(reader.memories).mockResolvedValue([
      memory({ summary: "An unrelated phrase" }),
    ]);
    vi.mocked(reader.memorySources).mockResolvedValue([
      {
        id: "source",
        memoryId: "memory-a",
        sourceType: "interaction",
        sourceId: null,
        sourceEntityId: null,
        sourceInteractionId: ids.interaction,
        provenanceNote: "Own scene evidence",
        createdAt: date,
      },
    ]);
    const bundle = await createContextBuilder(reader)({
      ...request,
      limits: { sourcesPerRecord: 0 },
    });
    expect(bundle.memories).toMatchObject([
      {
        reasons: ["scene_interaction_provenance"],
        provenance: { sources: [], omitted: 1 },
      },
    ]);
  });

  it("ranks scene-location claims before generic self beliefs with equal lexical matches", async () => {
    const scene = await reader.context(ids.world, ids.scene);
    vi.mocked(reader.context).mockResolvedValue({
      ...scene!,
      linkedLocationEntityId: ids.otherScene,
    });
    vi.mocked(reader.knowledge).mockResolvedValue([
      knowledge({ id: "a-self", subjectEntityId: ids.npc }),
      knowledge({ id: "z-location", subjectEntityId: ids.otherScene }),
    ]);
    const bundle = await createContextBuilder(reader)({
      ...request,
      limits: { knowledge: 1 },
    });
    expect(bundle.knowledge[0].claims[0].record.id).toBe("z-location");
    expect(bundle.knowledge[0].claims[0].reasons).toContain("scene_location");
  });
  it("resolves the scoped persisted interaction and essential NPC baseline", async () => {
    const bundle = await createContextBuilder(reader)(request);
    expect(reader.interaction).toHaveBeenCalledWith(
      ids.world,
      ids.npc,
      ids.interaction,
    );
    expect(bundle.npc.npc.baselineProfile).toEqual({ summary: "An analyst" });
    expect(bundle.current.requester?.id).toBe(ids.speaker);
    expect(bundle.current.context?.id).toBe(ids.scene);
    expect(bundle.current.interaction.status).toBe("received");
    expect(bundle.budget.estimatedBytes).toBe(estimateContextBytes(bundle));
  });
  it.each(["world", "npc", "interaction"] as const)(
    "rejects missing %s",
    async (method) => {
      vi.mocked(reader[method]).mockResolvedValue(null);
      await expect(
        createContextBuilder(reader)(request),
      ).rejects.toBeInstanceOf(ContextUnavailableError);
    },
  );
  it.each([
    { worldId: ids.foreign },
    { npcId: ids.otherNpc },
    { id: ids.foreign },
  ])("rejects an incorrectly scoped interaction %j", async (overrides) => {
    vi.mocked(reader.interaction).mockResolvedValue(interaction(overrides));
    await expect(createContextBuilder(reader)(request)).rejects.toBeInstanceOf(
      ContextUnavailableError,
    );
  });
  it("keeps only this NPC's same-scene storage history, excluding current and future rows", async () => {
    vi.mocked(reader.history).mockResolvedValue([
      interaction(),
      interaction({ id: "earlier", createdAt: date }),
      interaction({
        id: "other-scene",
        contextId: ids.otherScene,
        createdAt: date,
      }),
      interaction({ id: "other-world", worldId: ids.foreign, createdAt: date }),
      interaction({ id: "other-npc", npcId: ids.otherNpc, createdAt: date }),
      interaction({
        id: "future",
        createdAt: new Date("2026-01-03T00:00:00Z"),
      }),
    ]);
    const bundle = await createContextBuilder(reader)(request);
    expect(reader.history).toHaveBeenCalledWith(ids.world, ids.npc, ids.scene, {
      before: currentDate,
      exclude: ids.interaction,
      limit: 10,
    });
    expect(bundle.history.map((item) => item.record.id)).toEqual(["earlier"]);
    expect(bundle.retrieval.categories.history.excluded).toBe(5);
  });
  it("uses deterministic technical recency and ID ties independent of repository order", async () => {
    const rows = [
      interaction({ id: "b", createdAt: date }),
      interaction({ id: "a", createdAt: date }),
      interaction({ id: "recent", createdAt: currentDate }),
    ];
    vi.mocked(reader.history).mockResolvedValue(rows);
    vi.mocked(reader.knowledge).mockResolvedValue([
      knowledge({ id: "b" }),
      knowledge({ id: "a" }),
    ]);
    const first = await createContextBuilder(reader)(request);
    vi.mocked(reader.history).mockResolvedValue([...rows].reverse());
    vi.mocked(reader.knowledge).mockResolvedValue([
      knowledge({ id: "a" }),
      knowledge({ id: "b" }),
    ]);
    const second = await createContextBuilder(reader)(request);
    expect(second).toEqual(first);
    expect(first.history.map((item) => item.record.id)).toEqual([
      "recent",
      "a",
      "b",
    ]);
  });
  it("handles absent speaker, game profile and runtime state explicitly", async () => {
    vi.mocked(reader.interaction).mockResolvedValue(
      interaction({ speakerEntityId: null }),
    );
    const npc = await reader.npc(ids.world, ids.npc);
    vi.mocked(reader.npc).mockResolvedValue({ ...npc!, state: null });
    const bundle = await createContextBuilder(reader)(request);
    expect(bundle.current.requester).toBeNull();
    expect(bundle.missing).toEqual(
      expect.arrayContaining([
        "speaker_unknown",
        "game_profile_missing",
        "npc_state_missing",
        "scene_history_empty_or_unavailable",
      ]),
    );
  });
  it("does not expose a requester resolved from another world", async () => {
    vi.mocked(reader.entity).mockResolvedValue(
      entity({ worldId: ids.foreign }),
    );
    const bundle = await createContextBuilder(reader)(request);
    expect(bundle.current.requester).toBeNull();
    expect(bundle.missing).toContain("speaker_unavailable");
  });
  it("handles unavailable and inactive originating contexts without retrieving history", async () => {
    vi.mocked(reader.context).mockResolvedValue(null);
    const bundle = await createContextBuilder(reader)(request);
    expect(bundle.current.context).toBeNull();
    expect(bundle.missing).toContain("origin_context_unavailable");
    expect(reader.history).not.toHaveBeenCalled();
  });
  it("isolates subjective knowledge and memories by owner, world and eligible statuses", async () => {
    vi.mocked(reader.knowledge).mockResolvedValue([
      knowledge(),
      knowledge({ id: "foreign", worldId: ids.foreign }),
      knowledge({ id: "other", npcId: ids.otherNpc }),
      knowledge({ id: "invalid", status: "invalidated" }),
      knowledge({ id: "outdated", status: "outdated" }),
    ]);
    vi.mocked(reader.memories).mockResolvedValue([
      memory(),
      memory({ id: "foreign", worldId: ids.foreign }),
      memory({ id: "other", npcId: ids.otherNpc }),
      memory({ id: "archived", status: "archived" }),
      memory({ id: "invalid", status: "invalidated" }),
      memory({ id: "consolidated", status: "consolidated" }),
    ]);
    const bundle = await createContextBuilder(reader)(request);
    expect(
      bundle.knowledge.flatMap((group) =>
        group.claims.map((item) => item.record.id),
      ),
    ).toEqual(["claim-a"]);
    expect(bundle.memories.map((item) => item.record.id)).toEqual(["memory-a"]);
    expect(bundle.knowledge[0].claims[0].record).toMatchObject({
      secrecy: "private",
      classification: "reported_claim",
      confidence: 0.4,
    });
  });
  it("preserves contradictory beliefs and does not rank a claim as objective truth", async () => {
    vi.mocked(reader.knowledge).mockResolvedValue([
      knowledge(),
      knowledge({
        id: "claim-b",
        claimText: "The manifest is incorrect",
        status: "disputed",
        confidence: 0.9,
      }),
    ]);
    vi.mocked(reader.conflicts).mockResolvedValue([
      {
        id: "conflict",
        worldId: ids.world,
        npcId: ids.npc,
        claimAId: "claim-a",
        claimBId: "claim-b",
        status: "unresolved",
        createdAt: date,
        resolvedAt: null,
        resolutionNote: null,
      },
    ]);
    const bundle = await createContextBuilder(reader)(request);
    expect(bundle.knowledge[0].claims).toHaveLength(2);
    expect(bundle.knowledge[0].conflicts).toHaveLength(1);
    const limited = await createContextBuilder(reader)({
      ...request,
      limits: { knowledge: 1 },
    });
    expect(limited.knowledge).toHaveLength(0);
    expect(limited.retrieval.categories.knowledge.omittedByLimit).toBe(2);
    expect(limited.budget.truncated).toBe(true);
  });
  it("omits a conflict component with an unavailable partner without leaking its identifier", async () => {
    vi.mocked(reader.knowledge).mockResolvedValue([knowledge()]);
    vi.mocked(reader.conflicts).mockResolvedValue([
      {
        id: "conflict",
        worldId: ids.world,
        npcId: ids.npc,
        claimAId: "claim-a",
        claimBId: "private-other-npc-claim",
        status: "unresolved",
        createdAt: date,
        resolvedAt: null,
        resolutionNote: null,
      },
    ]);
    const bundle = await createContextBuilder(reader)(request);
    expect(bundle.knowledge).toHaveLength(0);
    expect(bundle.retrieval.categories.knowledge.unavailable).toBe(1);
    expect(JSON.stringify(bundle)).not.toContain("private-other-npc-claim");
  });
  it("includes only the NPC's outgoing relationship with known scene participants", async () => {
    vi.mocked(reader.relationships).mockResolvedValue([
      relationship(),
      relationship({
        id: "incoming",
        sourceEntityId: ids.speaker,
        targetEntityId: ids.npc,
      }),
      relationship({ id: "foreign", worldId: ids.foreign }),
      relationship({ id: "unrelated", targetEntityId: ids.foreign }),
    ]);
    const bundle = await createContextBuilder(reader)(request);
    expect(bundle.relationships).toMatchObject([
      {
        record: { id: "relationship-a", sourceEntityId: ids.npc },
        participant: { id: ids.speaker },
        reasons: ["current_requester"],
      },
    ]);
  });
  it("ranks scene location and request evidence above unrelated claims", async () => {
    vi.mocked(reader.knowledge).mockResolvedValue([
      knowledge({
        id: "irrelevant",
        subjectEntityId: null,
        claimText: "A distant harvest was abundant",
      }),
      knowledge({ id: "relevant" }),
    ]);
    const bundle = await createContextBuilder(reader)(request);
    expect(bundle.knowledge).toHaveLength(1);
    expect(bundle.knowledge[0].claims[0].record.id).toBe("relevant");
    expect(bundle.retrieval.categories.knowledge.irrelevant).toBe(1);
  });
  it("preserves owned provenance, bounds it, and never expands another NPC's archive claim", async () => {
    vi.mocked(reader.knowledge).mockResolvedValue([knowledge()]);
    vi.mocked(reader.knowledgeSources).mockResolvedValue([
      {
        id: "known",
        knowledgeId: "claim-a",
        sourceType: "archive",
        sourceEntityId: null,
        sourceKnowledgeId: null,
        sourceMemoryId: null,
        externalRef: "archive-reference",
        chainDepth: 0,
        provenanceNote: "Already read by this NPC",
        createdAt: date,
      },
      {
        id: "other",
        knowledgeId: "claim-a",
        sourceType: "heard",
        sourceEntityId: null,
        sourceKnowledgeId: "other-npc-secret",
        sourceMemoryId: null,
        externalRef: null,
        chainDepth: 1,
        provenanceNote: "Unavailable provenance",
        createdAt: date,
      },
    ]);
    const bundle = await createContextBuilder(reader)(request);
    expect(bundle.knowledge[0].claims[0].provenance).toMatchObject({
      total: 2,
      unavailable: 1,
      sources: [{ id: "known", externalRef: "archive-reference" }],
    });
    expect(JSON.stringify(bundle)).not.toContain("other-npc-secret");
    const noSources = await createContextBuilder(reader)({
      ...request,
      limits: { sourcesPerRecord: 0 },
    });
    expect(noSources.knowledge[0].claims[0].provenance.omitted).toBe(1);
    expect(noSources.retrieval.provenanceTruncated).toBe(true);
  });
  it("bounds the entire serialized bundle, preserves essentials and reports category omissions", async () => {
    vi.mocked(reader.knowledge).mockResolvedValue([
      knowledge({ claimText: "docking " + "x".repeat(3000) }),
    ]);
    vi.mocked(reader.memories).mockResolvedValue([memory()]);
    vi.mocked(reader.history).mockResolvedValue([
      interaction({ id: "history", createdAt: date }),
    ]);
    const full = await createContextBuilder(reader)(request);
    const reduced = await createContextBuilder(reader)({
      ...request,
      maxBytes: full.budget.estimatedBytes - 1000,
    });
    expect(reduced.budget.estimatedBytes).toBe(estimateContextBytes(reduced));
    expect(estimateContextBytes(reduced)).toBeLessThanOrEqual(
      reduced.budget.maxBytes,
    );
    expect(reduced.current.interaction.requestText).toBe(
      full.current.interaction.requestText,
    );
    expect(reduced.npc).toEqual(full.npc);
    expect(reduced.budget.truncated).toBe(true);
    expect(reduced.retrieval.categories.knowledge.selected).toBe(1);
    expect(
      reduced.retrieval.categories.memories.omittedByBudget +
        reduced.retrieval.categories.history.omittedByBudget,
    ).toBeGreaterThan(0);
  });
  it("rejects budgets that cannot retain essential context", async () => {
    await expect(
      createContextBuilder(reader)({ ...request, maxBytes: 1 }),
    ).rejects.toBeInstanceOf(ContextBudgetExceededError);
  });
  it("reports count limits even when the byte budget is generous", async () => {
    vi.mocked(reader.memories).mockResolvedValue([
      memory(),
      memory({ id: "b" }),
    ]);
    const bundle = await createContextBuilder(reader)({
      ...request,
      limits: { memories: 1 },
    });
    expect(bundle.memories).toHaveLength(1);
    expect(bundle.retrieval.categories.memories.omittedByLimit).toBe(1);
  });
  it("keeps technical timestamps, unknown chronology and unestablished presence distinct", async () => {
    vi.mocked(reader.context).mockResolvedValue({
      ...(await reader.context(ids.world, ids.scene)),
      metadata: { gameTime: "do not trust", physicalPresence: true },
    } as NonNullable<Awaited<ReturnType<ContextReader["context"]>>>);
    const bundle = await createContextBuilder(reader)(request);
    expect(bundle.temporal).toEqual({
      gameTime: null,
      sceneChronology: "unknown",
      parallelScenes: "not_sequenced",
      timestamps: "technical_storage_only",
    });
    expect(bundle.presence).toEqual({
      scenePresence: "not_established",
      remoteReachability: "unknown",
    });
    expect(bundle.npc.state?.currentLocationId).toBeNull();
    expect(bundle.current.context).not.toHaveProperty("metadata");
  });
  it("never mutates reader data, persists records, invokes transport or schedules work", async () => {
    const value = interaction();
    vi.mocked(reader.interaction).mockResolvedValue(value);
    const before = structuredClone(value);
    await createContextBuilder(reader)(request);
    expect(value).toEqual(before);
    expect(Object.keys(reader).sort()).toEqual([
      "capabilities",
      "conflicts",
      "context",
      "entity",
      "gameProfile",
      "history",
      "interaction",
      "knowledge",
      "knowledgeSources",
      "memories",
      "memorySources",
      "npc",
      "relationships",
      "world",
    ]);
  });
  it("propagates repository failures without inventing a partial context", async () => {
    vi.mocked(reader.knowledge).mockRejectedValue(
      new Error("database unavailable"),
    );
    await expect(createContextBuilder(reader)(request)).rejects.toThrow(
      "database unavailable",
    );
  });
  it.each([
    { maxBytes: 0 },
    { limits: { knowledge: -1 } },
    { npcId: "invalid" },
  ])("validates retrieval configuration %j", async (invalid) => {
    await expect(
      createContextBuilder(reader)({ ...request, ...invalid }),
    ).rejects.toThrow();
    expect(reader.world).not.toHaveBeenCalled();
  });
});
