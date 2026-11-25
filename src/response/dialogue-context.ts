export const dialogueVersion = "npc-speech-m219-v1" as const;

type Pair = { player: string; speech: string };

const commonTerms = new Set([
  "about",
  "again",
  "could",
  "would",
  "should",
  "please",
  "what",
  "which",
  "when",
  "where",
  "those",
  "these",
  "there",
  "have",
  "with",
  "that",
  "this",
  "were",
  "your",
  "just",
  "tell",
  "want",
  "need",
  "think",
  "kolko",
  "ktore",
  "ktory",
  "ktora",
  "tieto",
  "tento",
  "tamto",
  "este",
  "prosim",
  "mozes",
  "mohol",
  "chcem",
  "potrebujem",
  "povedz",
  "myslis",
  "alebo",
  "teda",
  "dobre",
]);

const terms = (text: string) =>
  new Set(
    (
      text
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .match(/[\p{L}\p{N}]{3,}/gu) ?? []
    ).filter((term) => !commonTerms.has(term)),
  );

function overlap(left: Set<string>, right: Set<string>) {
  return [...left].filter((term) => right.has(term)).length;
}

const excerpt = (pair: Pair, playerChars: number, npcChars: number) => ({
  player: pair.player.slice(0, playerChars),
  speech: pair.speech.slice(0, npcChars),
});

// Input is newest first, exactly as delivered history is read from PostgreSQL.
// The most recent turns are retained for pronouns, correction and short
// follow-ups; older generated NPC prose never independently selects an excerpt.
export function selectM219History(pairs: readonly Pair[], request: string) {
  const requestTerms = terms(request);
  const recentCount = requestTerms.size <= 1 ? 3 : 2;
  const recent = pairs
    .slice(0, recentCount)
    .reverse()
    .map((pair) => excerpt(pair, 220, 240));
  const excerpts = pairs
    .slice(recentCount)
    .map((pair, index) => ({
      pair,
      index,
      score: overlap(terms(pair.player), requestTerms),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => b.index - a.index)
    .map(({ pair }) => excerpt(pair, 140, 160));
  return { recent, excerpts };
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const boundedText = (value: unknown, limit: number) =>
  typeof value === "string" ? value.slice(0, limit) : undefined;
const boundedList = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, 8)
        .map((item) => item.slice(0, 100))
    : undefined;

// Only called on the already visibility-filtered persona. The source profile
// is not mutated. No mechanics, relationship notes or DM secrets are copied.
export function projectConversationalPersona(value: unknown) {
  const persona = object(value);
  const identity = object(persona.identity);
  const personality = object(persona.personality);
  return {
    name: boundedText(persona.name, 200),
    species: boundedText(identity.species, 100),
    role: boundedText(identity.role ?? persona.role, 160),
    summary: boundedText(persona.summary, 500),
    traits: boundedList(personality.traits ?? persona.traits),
    values: boundedList(personality.values),
  };
}

function relevantRecords(value: unknown, request: string) {
  if (!Array.isArray(value)) return [];
  const requestTerms = terms(request);
  // No new records are exposed: rank only records already authorized by the
  // visibility filter. Keep a small fallback on ambiguous follow-ups.
  const ranked = value
    .map((record, index) => ({
      record,
      index,
      score: overlap(
        terms(String(object(record).statement ?? object(record).summary ?? "")),
        requestTerms,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return requestTerms.size <= 1
    ? ranked.slice(0, 3).map((entry) => entry.record)
    : ranked
        .filter((entry) => entry.score > 0)
        .slice(0, 4)
        .map((entry) => entry.record);
}

// The current request is last and clearly delimited as untrusted data.
// Do not include game-stat dumps, repeated absence markers or opaque IDs.
// The security policy and exact token budget still live in the shared pipeline.
export function composeM219Context(sections: Record<string, unknown>) {
  const scene = object(sections.currentSceneAndInteraction);
  const request =
    typeof scene.requestText === "string" ? scene.requestText : "";
  const history = Array.isArray(sections.sceneHistory)
    ? sections.sceneHistory
    : [];
  const excerpts = Array.isArray(sections.olderAttributedDialogueExcerpts)
    ? sections.olderAttributedDialogueExcerpts
    : [];
  const records = [
    ["NPC characterization", projectConversationalPersona(sections.persona)],
    ["Permitted scene state", sections.currentNpcState ?? {}],
    [
      "Permitted attributed knowledge",
      relevantRecords(sections.permittedKnowledge, request),
    ],
    [
      "Permitted attributed recollections",
      relevantRecords(sections.permittedMemories, request),
    ],
    ["Older attributed dialogue (not world truth)", excerpts],
    ["Recent attributed dialogue (not world truth)", history],
    ["Current player request", request],
  ] as const;
  return records
    .map(([label, data]) => label + ": " + JSON.stringify(data))
    .join("\n");
}

// Diagnostic only: never suppress or rewrite a valid reply based on overlap.
export function repetitionCounts(speech: string, history: readonly Pair[]) {
  const normalize = (text: string) =>
    text
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const sentences = (text: string) =>
    text
      .split(/[.!?\n]+/u)
      .map(normalize)
      .filter((item) => item.split(" ").length >= 4);
  const current = sentences(speech);
  const prior = new Set(history.flatMap((pair) => sentences(pair.speech)));
  return {
    repeatedSentences: current.filter((item) => prior.has(item)).length,
    exactReplyRepeated: history.some(
      (pair) => normalize(pair.speech) === normalize(speech),
    ),
  };
}
