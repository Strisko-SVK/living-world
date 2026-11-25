import { describe, expect, it } from "vitest";
import { nativeTurnMarker, parseTurnCandidates } from "./enrichment.js";
describe("native turn enrichment conservative extraction", () => {
  it("rejects unexpected JSON, unsupported effect fields and oversized sentiment", () => {
    expect(() => parseTurnCandidates(JSON.stringify({
      memory:null,knowledge:null,relationship:null,task:null,worldPatch:{evil:true},
    }))).toThrow();
    expect(() => parseTurnCandidates(JSON.stringify({
      memory:null,knowledge:null,relationship:{event:"insult",trust:20,respect:0},task:null,
    }))).toThrow();
    expect(() => parseTurnCandidates(JSON.stringify({
      memory:null,knowledge:{claim:"x"},relationship:null,task:null,
    }))).toThrow();
  });
  it("accepts explicit nullable effects without performing any writes", () => {
    expect(parseTurnCandidates('{"memory":null,"knowledge":null,"relationship":null,"task":null}'))
      .toEqual({memory:null,knowledge:null,relationship:null,task:null});
    expect(nativeTurnMarker("94ca7b6e-7ba3-4b58-a0bd-99f5c95f85d0"))
      .toBe("living-world-native-turn:94ca7b6e-7ba3-4b58-a0bd-99f5c95f85d0");
  });
});
