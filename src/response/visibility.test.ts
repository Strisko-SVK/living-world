import { describe, expect, it, vi } from "vitest";
import { ids, date, knowledge } from "../context/context.test-fixture.js";
import { responseFixture } from "./response.test-fixture.js";
import { filterResponseContext, VisibilityBlocked } from "./visibility.js";
import { validateNpcSpeech } from "./prompt.js";

async function fixture() {
  const f = await responseFixture();
  vi.mocked(f.reader.knowledge).mockResolvedValue([
    knowledge({ secrecy: "public" }),
  ]);
  vi.mocked(f.reader.knowledgeSources).mockResolvedValue([
    {
      id: "source",
      knowledgeId: "claim-a",
      sourceType: "heard",
      sourceEntityId: ids.speaker,
      sourceKnowledgeId: null,
      sourceMemoryId: null,
      externalRef: null,
      chainDepth: 0,
      provenanceNote: "Not a disclosure grant",
      createdAt: date,
    },
  ]);
  const bundle = await f.deps.build({
    worldId: ids.world,
    npcId: ids.npc,
    interactionId: ids.interaction,
  });
  return { f, bundle };
}
describe("conservative response access boundary", () => {
  it.each(["heard", "witnessed", "read", "official"] as const)(
    "does not accept %s labels or NPC/requester identity as exposure evidence",
    async (sourceType) => {
      const { f, bundle } = await fixture();
      const claim = bundle.knowledge[0].claims[0];
      for (const entity of [ids.speaker, ids.npc, ids.otherNpc, null]) {
        claim.provenance.sources[0].sourceType = sourceType;
        claim.provenance.sources[0].sourceEntityId = entity;
        claim.provenance.sources[0].provenanceNote =
          "NPC definitely heard this in Discord";
        const permitted = filterResponseContext(bundle, f.current);
        expect(permitted.sections.permittedKnowledge).toEqual([]);
        expect(permitted.excludedText).toContain(claim.record.claimText);
        expect(JSON.stringify(permitted.sections)).not.toContain(
          claim.record.claimText,
        );
      }
    },
  );
  it("accepts explicit current local location evidence without admitting historical knowledge", async () => {
    const { f, bundle } = await fixture();
    expect(
      filterResponseContext(bundle, f.current).sections
        .currentSceneAndInteraction,
    ).toMatchObject({
      requestText: f.current.requestText,
    });
    bundle.npc.state!.locationCertainty = "unknown";
    expect(() => filterResponseContext(bundle, f.current)).toThrow(
      VisibilityBlocked,
    );
  });
  it.each(["private", "secret", "restricted"] as const)(
    "excludes %s beliefs",
    async (secrecy) => {
      const { f, bundle } = await fixture();
      bundle.knowledge[0].claims[0].record.secrecy = secrecy;
      expect(
        filterResponseContext(bundle, f.current).sections.permittedKnowledge,
      ).toEqual([]);
    },
  );
  it("never splits a mixed public/restricted conflict group", async () => {
    const { f, bundle } = await fixture();
    const a = bundle.knowledge[0].claims[0];
    bundle.knowledge[0].claims.push({
      ...structuredClone(a),
      record: { ...a.record, id: "b", secrecy: "restricted" },
    });
    expect(
      filterResponseContext(bundle, f.current).sections.permittedKnowledge,
    ).toEqual([]);
  });
  it.each([
    "owner",
    "world",
    "status",
    "future",
    "capped",
    "unavailable",
    "archive",
    "other_source",
    "memory_reference",
  ])("excludes inaccessible knowledge/provenance: %s", async (condition) => {
    const { f, bundle } = await fixture();
    const claim = bundle.knowledge[0].claims[0];
    if (condition === "owner") claim.record.npcId = ids.otherNpc;
    if (condition === "world") claim.record.worldId = ids.foreign;
    if (condition === "status") claim.record.status = "invalidated";
    if (condition === "future")
      claim.record.updatedAt = new Date("2026-01-03T00:00:00Z");
    if (condition === "capped") claim.provenance.omitted = 1;
    if (condition === "unavailable") claim.provenance.unavailable = 1;
    if (condition === "archive")
      claim.provenance.sources[0].sourceType = "archive";
    if (condition === "other_source")
      claim.provenance.sources[0].sourceEntityId = ids.otherNpc;
    if (condition === "memory_reference")
      claim.provenance.sources[0].sourceMemoryId = "unclassified-memory";
    expect(
      filterResponseContext(bundle, f.current).sections.permittedKnowledge,
    ).toEqual([]);
  });
  it.each(["world", "npc", "context", "speaker", "timestamp", "state"])(
    "blocks inconsistent bundle %s",
    async (field) => {
      const { f, bundle } = await fixture();
      if (field === "world") bundle.world.id = ids.foreign;
      if (field === "npc") bundle.npc.npc.entityId = ids.otherNpc;
      if (field === "context") bundle.current.context!.worldId = ids.foreign;
      if (field === "speaker") bundle.current.requester!.worldId = ids.foreign;
      if (field === "timestamp")
        bundle.current.interaction = {
          ...bundle.current.interaction,
          createdAt: date,
        };
      if (field === "state") bundle.npc.state!.npcId = ids.otherNpc;
      expect(() => filterResponseContext(bundle, f.current)).toThrow(
        VisibilityBlocked,
      );
    },
  );
  it("is deterministic and does not mutate Context Builder output", async () => {
    const { f, bundle } = await fixture(),
      before = structuredClone(bundle);
    expect(filterResponseContext(bundle, f.current)).toEqual(
      filterResponseContext(bundle, f.current),
    );
    expect(bundle).toEqual(before);
  });
  it("accepts bounded plain speech and rejects control characters and extra action structure", () => {
    expect(validateNpcSpeech('{"speech":" Hello. "}', 10, [])).toBe("Hello.");
    expect(
      validateNpcSpeech(JSON.stringify({ speech: "bad\u0000text" }), 100, []),
    ).toBeNull();
    expect(
      validateNpcSpeech('{"speech":"ok","task":"accept"}', 100, []),
    ).toBeNull();
    expect(validateNpcSpeech('{"speech":"a longer phrase"}', 3, [])).toBeNull();
  });
});
