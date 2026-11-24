import { randomUUID } from "node:crypto";
import type { GenerationRequest, GenerationResult } from "../llm/contracts.js";
import {
  composeResponsePrompt,
  validateNpcSpeech,
} from "../response/prompt.js";

const cases = [
  [
    "en-en",
    "How many coolant canisters are left, and how many can I negotiate for?",
  ],
  ["sk-sk", "Koľko kanistrov chladiva máte a o koľkých sa môžeme dohodnúť?"],
  [
    "sk-en",
    "Koľko kanistrov chladiva máte a o koľkých sa môžeme dohodnúť? Odpovedz po anglicky.",
  ],
  [
    "en-sk",
    "How many coolant canisters are left, and how many can I negotiate for? Answer in Slovak.",
  ],
  [
    "mixed",
    "Koľko coolant canisters nám vieš ponúknuť? Odpovedz po slovensky.",
  ],
  [
    "no-diacritics",
    "Kolko kanistrov chladiva mate a o kolkych sa mozeme dohodnut?",
  ],
  [
    "informal-sk",
    "Čau Voss, máš ešte dačo z chladiva? Koľko pustíš do výmeny?",
  ],
  [
    "domain-sk",
    "Sú v rezerve tesnenia čerpadla, alebo ich chceš vymeniť za kanistre chladiva?",
  ],
  ["small-talk", "How are you today, Voss?"],
  [
    "reported-claim",
    "A dockhand said the seal was broken. Do you know who broke it?",
  ],
] as const;

export async function runRaonBenchmark(
  generate: (request: GenerationRequest) => Promise<GenerationResult>,
  signal: AbortSignal,
) {
  for (const [id, requestText] of cases) {
    for (const variant of ["baseline", "natural"] as const) {
      signal.throwIfAborted();
      const prompt = composeResponsePrompt(
        {
          sections: {
            persona: {
              name: "Marcus Voss",
              role: "Quartermaster",
              traits: ["pragmatic", "dry wit", "protective of the crew"],
            },
            currentNpcState: {
              physical: {
                summary: "At the supply counter after the morning count.",
              },
            },
            permittedKnowledge: [
              {
                kind: "fixture_fact",
                statement:
                  "Six coolant canisters remain. Four are reserved for Engineering and two are available for negotiation. Voss wants clean pump seals in exchange.",
              },
              {
                kind: "reported_claim",
                statement:
                  "Niko reported that the blue crate's seal was broken upon arrival. Voss does not know who broke it.",
              },
            ],
            currentSceneAndInteraction: { requestText },
          },
          excludedText: [],
          omissions: {
            history: 0,
            knowledgeGroups: 0,
            memories: 0,
            relationships: 0,
          },
        },
        600,
        variant === "baseline" ? true : "natural",
      );
      const started = performance.now();
      const result = await generate({
        ...prompt,
        traceId: randomUUID(),
        signal,
      });
      console.info(
        JSON.stringify({
          event: "raon_benchmark",
          id,
          variant,
          elapsedMs: Math.round(performance.now() - started),
          outcome: result.ok ? "generated" : result.error,
          // This explicit command uses synthetic prompts only. The response is
          // printed for human language and grounding review, separate from logs.
          ...(result.ok && {
            usage: result.observation.usage,
            speech: validateNpcSpeech(result.text, 600, []),
          }),
        }),
      );
    }
  }
}
