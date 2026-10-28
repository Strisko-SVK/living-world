## Development

- Runtime: Node.js 22+ (required by the official OpenAI SDK)
- Package manager: pnpm
- Install: `pnpm install`
- Develop: `pnpm dev`
- Test: `pnpm test`
- Quality gate: `pnpm quality:gate`

### Local PostgreSQL

1. Copy `.env.example` to `.env` and adjust values if needed.
2. Start PostgreSQL: `pnpm db:up`
3. Generate and run migrations: `pnpm db:generate`, then `pnpm db:migrate`
4. Run the database integration test: `pnpm test:db`

Entity repository APIs are always world-scoped. The DB integration suite verifies
that entities and aliases cannot be retrieved across worlds.

NPC persistence separates the immutable baseline profile from mutable runtime
state. Game profiles and semantic capabilities are stored independently, and all
NPC repository APIs are world-scoped.

NPC memory persistence stores subjective NPC history separately from Knowledge
and World Truth. Provenance is stored independently from immutable memory
summaries, while status and memory-to-memory relations may be added over time.
All memory repository APIs are scoped by world and NPC.

NPC knowledge persistence stores subjective claims separately from memory and
World Truth. Confidence represents how strongly the NPC holds a claim, and not
its objective probability. Conflicting claims may coexist, provenance is stored
separately, and all knowledge APIs are world- and NPC-scoped.

Relationships are directional and multidimensional state, separate from memory,
knowledge, membership, and reputation. Explicit relationship events preserve why
state changes occurred, and all relationship APIs are world-scoped.

Interactions are transport-neutral; Discord will later be an adapter rather than
the domain model. A conversation context is distinct from a world location, and
communication mode is distinct from physical presence. Interaction lifecycle and
trace IDs are persisted for future observability and processors; no automatic
memory, knowledge, or relationship extraction exists yet.

Tasks persist beyond their originating interactions and have an explicit,
world-scoped lifecycle. Task execution state is separate from report delivery;
transport delivery will be added later.

Discord mapping persistence is transport metadata only: a Discord user is not a
player character and may map to multiple world entities. Discord contexts and
NPC primary spaces are not world locations or physical presence. The M2.4 adapter
accepts mapped inbound guild messages; it sends no Discord messages.

### M2.3.1 integrity rules

Discord locations are unique per world, including channel mappings with a null
thread ID (`UNIQUE NULLS NOT DISTINCT`, PostgreSQL 15+). Multiple distinct threads
under one channel remain valid. Lookup checks the exact active thread before the
active channel fallback. Location uniqueness includes inactive rows; reusing a
location requires an explicit update rather than inserting a conflicting record.
See [PostgreSQL unique indexes](https://www.postgresql.org/docs/17/indexes-unique.html).

Each Discord user may have multiple character mappings, but at most one active
primary mapping per world. Inactive mappings cannot be primary. Primary creation,
selection and deactivation use transaction-scoped advisory locks per world/user,
with unique/check constraints protecting direct database writes. Concurrent
explicit selections are serialized; the last successful selection wins.
Deactivation clears primary status and leaves no replacement until explicitly
selected. If an entity has multiple active identity mapping types, primary selection
rejects ambiguity. NPC primary routing is similarly serialized and constrained;
selecting a context with multiple active Discord mappings rejects ambiguity.
Mappings never change NPC physical state.

External interaction IDs remain opaque strings (including leading zeros), with
no whitespace/control characters and a 2,000-character limit. Provider names
have a 100-character limit. External context locations require a provider;
guild/thread references require a channel. Missing message IDs stay absent.
Source and response message IDs must differ; response text remains immutable.
Memory and relationship interaction provenance must reference an existing
interaction in the same world, and the owning NPC when applicable.

Migration `0008_mapping_integrity` locks affected tables and checks existing
location/primary conflicts, world references and interaction provenance before
installing constraints. It aborts without deleting or merging records; any
conflicts require explicit operator resolution before retrying. Candidate keys
precede composite foreign keys. Migrations 0000–0007 remain unchanged.

Composite foreign keys now protect context locations, interaction contexts/NPCs/
speakers, Discord identities/contexts/NPCs and task assignees/requesters/origins.
Task reports and older provenance rows derive world/NPC ownership through parent
records rather than storing world IDs themselves. Their repositories validate
ownership, but direct SQL can still connect existing records across those parent
boundaries. A later migration can add/backfill world IDs and composite foreign
keys if database enforcement is required there; adding consistency triggers is
another option. This milestone adds existence FKs for interaction provenance
without restructuring those older tables. Lifecycle transitions and external ID
validation remain repository responsibilities, so direct SQL must use care.

Task reports currently expose only `pending` to `delivered` delivery transitions.
`failed` and `skipped` enum states have no transition APIs; those are deferred to
the task/report delivery workflow and are not needed for M2.4 inbound intake.

### M2.4 Discord adapter

This section documents the foundation's legacy mapped-target contract. The
application runtime now uses M2.8 explicit alias triggers and default-deny intake
authorization, described below. Legacy primary/operator targeting is available
only through the explicit internal `mapped` compatibility mode.

Use a Discord application bot account, not a user token. In the
[Discord Developer Portal](https://discord.com/developers/applications), create a
bot, enable **Message Content Intent**, and install it in the intended server
with the `bot` OAuth2 scope and **View Channel** access to configured channels
and threads. Grant access only to the intended locations. Send Messages and Read
Message History permissions are not needed by this adapter; it never fetches
message history or sends replies. Private threads must already be visible to
the bot. For details see the [Discord gateway documentation](https://docs.discord.com/developers/events/gateway).

Use Node.js 22.12+ and the pinned pnpm version. Copy `.env.example` to `.env` if
needed, retain the project's PostgreSQL configuration, and set:

```dotenv
DISCORD_ENABLED=true
DISCORD_TOKEN=your-local-bot-token
DISCORD_INTENTS=Guilds,GuildMessages,MessageContent
```

The three listed [gateway intents](https://discord.js.org/docs/packages/discord-api-types/main/v10/GatewayIntentBits%3AEnum)
are required and validated; extra intents are rejected. `DISCORD_ENABLED`
defaults to `false`, so ordinary imports and tests never log in. Tokens are
required only when enabled; do not commit `.env` or put a token in tracked files.

Start local PostgreSQL with `pnpm db:up` if needed, run `pnpm db:migrate`, then
`pnpm dev` (loads `.env`). Production-style local startup is `pnpm build` followed
by `pnpm start`. Startup checks the database before logging in. SIGINT/SIGTERM
stop intake, disconnect Discord, drain in-flight persistence and close the DB
pool. Safe structured diagnostics report startup, ready, connection errors,
disconnect/resume, accepted intake and shutdown without content, IDs, tokens,
stack traces or raw SDK events. Discord.js manages gateway reconnections.

Create these records explicitly using the existing repository APIs before intake:

- An active world, active interaction context, and an active Discord location
  mapping (`mapDiscordContext`) for the guild/channel or exact thread.
- Active NPC entities and NPC profiles. Assign a primary space with
  `setNpcPrimaryContext` if messages without explicit mentions should target it.
- For supported `<@user-id>` / `<@!user-id>` NPC targeting, map that Discord user
  to one active NPC with `mappingType: "npc_operator"`. A user with multiple NPC
  operator targets is ambiguous, even if one mapping is primary.
- Optionally map authors using `player_character` identities. Multiple active
  characters require one explicit primary; otherwise intake is rejected. With
  no active character identity, the existing nullable speaker contract permits
  an unknown speaker. Operator mappings do not make an author speak as an NPC.

Eligibility and routing are deterministic:

1. Only new ordinary guild messages and replies in text/announcement channels
   and their visible threads are supported. Bots, webhooks, system/partial
   messages, DMs, edits, empty/oversized content and mention-only pings are ignored.
   Only minimal IDs, content and literal user-mention metadata are normalized;
   attachments, reply-author metadata and Discord timestamps are discarded.
2. Active matching exact-thread/channel mappings must identify exactly one
   active world. A location mapped across multiple worlds fails closed, even if
   one mapping is an exact thread. Within that world, resolve the exact thread
   before channel fallback; reject an inactive resolved context.
3. Literal user mentions present in SDK mention metadata target only explicitly
   mapped active NPC operators. Roles, display names, aliases and replied-to
   authors are not target selectors. Several individually unambiguous NPC
   mentions may target several NPCs. Ambiguous NPC mappings reject the whole
   event. If user mentions exist but identify no NPC, do not fall back to a
   primary NPC. Without mentions, require exactly one primary NPC attached to
   the resolved context. No targets means no persistence.
4. Validate target NPC/entity activity and world ownership. Persist all targets
   in one transaction through `createInteraction`, preserving the originating
   context even when a mentioned NPC has a different primary space. New rows
   have `received` status, `social` type (no intent classification yet),
   `unknown` communication mode, source message ID/provider, trace ID, speaker
   when known, and the original trimmed request text. A mention establishes
   neither physical presence nor remote reachability.

Migration `0009_discord_event_idempotency` adds a nullable source provider and a
partial unique index on `(world_id, npc_id, source_provider, source_message_id)`.
Discord intake supplies provider `discord`. Atomic conflict handling returns
the original interaction without replacing its text, context, trace, response
or lifecycle state. Different NPC targets remain independent; concurrent retries
cannot create duplicate rows. Existing unqualified message references remain
unchanged; no provider is inferred or backfilled into historical records.

Routing and persistence failures are isolated per event. Intake creates no
worlds, mappings, entities, tasks or NPCs. It does not alter physical state,
memories, knowledge, relationships or game time. There are no outbound messages,
LLM calls, Context Builder, commands, message-history scraping, permission
bypasses or automatic NPC responses. Failed events require redelivery/retry;
there is no retry queue. Mapping setup remains an operator responsibility, with
no provisioning UI or authorization policy beyond configured mappings yet.

Run `pnpm quality:gate` for deterministic tests and all static/build checks, then
`pnpm db:migrate` and `pnpm test:db` for real PostgreSQL constraints, concurrent
idempotency, routing and atomic rollback. Unit tests use fake transports and
repositories; they never open Discord connections. A live gateway smoke test
requires a separately configured bot token and mappings and is not automated.

### M2.5 NPC Context Builder

`createNpcContextBuilder(database.db)` from
`src/context/context.repository.ts` creates a read-only application service:

```ts
const buildContext = createNpcContextBuilder(database.db);
const bundle = await buildContext({
  worldId,
  npcId,
  interactionId,
  maxBytes: 48_000,
  limits: {
    knowledge: 12,
    memories: 8,
    relationships: 8,
    history: 10,
    capabilities: 12,
    sourcesPerRecord: 4,
  },
});
```

IDs must be UUIDs. Limits are optional integers from 0 through 500; the example
shows their defaults. `maxBytes` is a positive integer up to 10,000,000. Tests can
inject the read-only `ContextReader` port into `createContextBuilder(reader)`.
Production composition reuses the existing world, entity, NPC, interaction,
knowledge, memory and relationship repositories inside one PostgreSQL
`REPEATABLE READ READ ONLY` transaction. Reads use that connection sequentially.
There is no Discord/LLM dependency, listener, scheduled job or automatic invocation
from intake. Existing entity/world repository database types now also accept
transactions; their runtime behavior is unchanged.

The typed `NpcContextBundle` includes the NPC identity/baseline, stored state and
game profile; current interaction, requester and originating scene; subjective
knowledge with registered conflicts; memories with provenance; outgoing
relationships with known participants; recent scene history and capabilities.
It also includes missing-information codes, per-item selection reasons,
per-category counts, configured limits and byte-budget/truncation metadata.
Missing core world/NPC/interaction records or mismatched ownership throw
`ContextUnavailableError`. Missing state, game profile, speaker or scene are
represented explicitly. Missing or inactive scenes yield no history.

Scope and visibility rules:

- History comes only from this NPC's interactions in the originating world and
  context, excluding the current interaction and rows stored after its
  `createdAt`. Other NPCs' conversations are not assumed visible: there is no
  scene-membership/visibility model yet. Parallel/unrelated scenes are never
  fetched as history. Empty history is explicitly reported.
- Knowledge is restricted to this world/NPC and `current`/`disputed` statuses.
  Subject/object references must resolve in this world. Classification,
  confidence and secrecy remain subjective metadata, including claims labeled
  `fact`; they are never promoted to World Truth. Other NPCs' private beliefs
  and archive contents are not retrieved or expanded.
- Registered conflict-connected claims form indivisible groups. If one member
  is unavailable/ineligible, the accessible component is omitted and counted
  as unavailable. Count or byte limits omit whole groups rather than presenting
  one side without its recorded contradiction. Unregistered semantic
  contradictions are not inferred or resolved.
- Only `active` memories are included; archived, consolidated and invalidated
  memories and outdated/invalidated knowledge are excluded. Provenance is scoped
  through its owning record. Sources referencing unavailable/foreign entities,
  another NPC's interaction/knowledge, or ineligible memories/claims are omitted
  and counted. Archive/external references already recorded for this NPC remain
  references; the builder never follows them or fetches archive content.
- Relationships are only the NPC's outgoing perspective on the requester or
  speakers in the first `history`-limit eligible scene rows. Incoming feelings
  and unrelated participants' relationships are not disclosed. Knowing a
  participant from a recorded interaction does not establish physical presence.

Selection and budget rules are deterministic:

1. Retain the complete current interaction, scene projection, requester, world
   identity, NPC baseline/state and game profile as essential context. Arbitrary
   scene metadata and transport routing fields are excluded from the scene
   projection; they cannot assert game time or presence.
2. Rank eligible knowledge by scene-location matches (+20), known participant
   or self references (+10), distinct request-term overlap (+3 each), and scene
   history-term overlap (+1 each). A conflict group's score is its maximum claim
   score. Ignore zero-score groups; ties use the smallest claim ID ascending.
   Preserve all eligible secrecy levels because this is internal NPC context,
   not an authorized disclosure to another actor.
3. Rank memories by same-scene interaction provenance (+20), participant
   provenance (+10), and the same lexical scores. Ignore zero-score memories;
   ties use importance descending, technical `createdAt` descending, then ID
   ascending. Provenance caps affect output, not relevance scoring.
4. Add relevant relationships (requester first, then participant ID and row ID
   ascending), optional scene history (technical `createdAt` descending, then ID
   ascending), and capabilities (key ascending). Current scene/core information
   therefore precedes identity details, knowledge, memories, relationships and
   optional historical content. History terms/participants used for relevance
   are restricted to the first `history`-limit eligible rows, regardless of
   whether the eventual byte budget admits those rows.
5. Terms are lowercased Unicode letter/number runs of at least three characters;
   take the first 128 word tokens per text, then deduplicate. ID/key tie-breaking
   uses JavaScript ordinal string comparison, not locale-dependent collation.
   Provenance uses technical `createdAt` descending and ID ascending.
6. Category limits count records (knowledge limits count claims, not groups).
   Consider candidates in the priority order above. If an optional item/group
   cannot fit, omit it and continue to smaller candidates. Never shorten stored
   text or split a registered conflict group. Counts distinguish excluded,
   irrelevant, unavailable, limit-omitted and budget-omitted rows. Provenance
   reports total, unavailable and capped-source counts for every included record.
7. The full bundle, including metadata and reasons, must fit `maxBytes`.
   `estimateContextBytes` measures UTF-8 bytes of JSON with recursively sorted
   object keys and ISO serialization of existing Date values. This is a size
   estimate for future model input, not a tokenizer. The returned estimate
   includes its own budget field. If essentials and metadata cannot fit, throw
   `ContextBudgetExceededError` with `requiredBytes` and `maxBytes`; do not silently
   damage essential information. Output truncation is explicit.

No wall-clock timestamp is synthesized for the bundle. Storage timestamps only
support technical retrieval order, never in-game chronology. Existing recorded
dates are preserved without using them to sequence parallel scenes. The bundle
always reports unknown game time/scene chronology, unsequenced parallel scenes,
unestablished scene presence and unknown remote reachability. Stored physical
location/certainty remain separate from the conversation location. Nothing
advances world time, NPC state or interaction lifecycle.

Current limitations: repository list APIs enumerate owned rows before in-memory
ranking; output limits are not SQL pagination or an I/O bound. Large NPC archives
will need bounded/paged retrieval later. There is no semantic ranking, permission
model beyond world/NPC ownership, scene visibility model, reachability resolver,
tokenizer, prompt renderer or response/disclosure policy. The bundle is trusted
internal context and must not be exposed directly as an outbound NPC response.
No migrations, persistence writes, LLM calls, generated responses, Discord sends,
autonomous actions or scheduling are introduced.

Verify with `pnpm quality:gate` and `pnpm test:db`. Unit tests inject readers;
PostgreSQL composition tests exercise real repositories, isolation, contradictions,
provenance, budgets, deterministic output and absence of state/lifecycle changes.

### M2.6 LLM Provider Foundation

This is explicitly invoked text-generation infrastructure, not NPC orchestration.
Neither application startup, Discord intake nor Context Builder calls an LLM.
There are no Discord sends, domain writes, tools, agents or scheduled work.

Architecture: `llm/contracts.ts` owns transport-neutral requests, typed results,
usage and normalized failures. `llm/generation.ts` controls validation, deadlines,
retries and spending. `adapters/openai/provider.ts` isolates the official `openai`
SDK and Responses API behind `TextProvider`; SDK types/errors do not cross this
boundary. `llm/budget.repository.ts` supplies PostgreSQL accounting. Explicit
composition uses `createLlmService(database.db, environment, safeDiagnosticSink)`;
construction/import never makes a provider request. Tests inject providers and
budget stores into `createTextGenerator`, or inject a fake-fetch SDK into the
adapter. No framework or NPC response pipeline is introduced.

Configuration in `.env` (never committed):

- `LLM_PROVIDER`: `disabled` (default) or `openai`. Unsupported providers fail closed.
- `OPENAI_API_KEY`: required when enabled, nonempty and without whitespace. Create
  a restricted project key privately; set provider-side spending alerts/limits as
  an additional safeguard. No key or real model/price is supplied in examples.
- `LLM_MODEL`: exact identifier covered by your independently verified pricing.
  Choose a supported text-only Responses model with input-token counting and a
  standard-tier price. Requests may omit model or specify that same identifier;
  unpriced per-request model overrides are rejected. Model-specific unsupported
  generation parameters fail as permanent validation errors, not fallback calls.
- `LLM_TIMEOUT_MS`: default 30000, range 1–120000.
- `LLM_MAX_OUTPUT_TOKENS`: default 512, range 1–32768; callers can only lower it.
  This provider limit includes reasoning tokens, not only visible text.
- `LLM_MAX_ATTEMPTS`: default 2, range 1–3, including the first generation attempt.
- `LLM_CURRENCY` and `LLM_PRICE_CURRENCY`: required matching `USD` or `EUR`.
  Use prices actually denominated in that currency. USD and EUR are never
  equated; there is no exchange-rate source or automatic conversion.
- `LLM_MONTHLY_BUDGET_MICROS`: required integer 1–10000000. One million micro-units
  equals one reporting-currency unit. Choose an LLM-only ceiling substantially
  below the project's roughly €10–15 total monthly operating target, leaving
  infrastructure headroom. The 10-unit technical maximum is not an FX comparison
  or a claim that the full operating budget is available to the LLM.
- `LLM_REQUEST_BUDGET_MICROS`: optional positive integer ceiling, at most 10000000.
- `LLM_INPUT_MICROS_PER_MILLION` / `LLM_OUTPUT_MICROS_PER_MILLION`: required positive
  integer standard-tier rates, up to 1000000000 micro-units per million tokens.
  Verify rates against current official pricing for the configured model before
  enabling. No model prices are hardcoded. If a rate has finer precision than
  one micro-unit per million tokens, round it upward, never down.

Apply migration `0010_llm_budget_accounting` with `pnpm db:migrate` before use.
The minimal API is:

```ts
const generate = createLlmService(database.db, process.env, diagnostics);
const result = await generate({
  traceId, // UUID, safe correlation identifier, never raw user text
  instructions: {
    system: applicationOwnedPolicy,
    developer: applicationOwnedFormattingPolicy,
  },
  messages: [{ role: "user", content: untrustedContext }],
  maxOutputTokens: 128,
  // Optional lower per-request ceiling, in the configured currency's micro-units.
  requestBudgetMicros,
  signal: abortController.signal,
});
```

Only trusted application code may provide `instructions`. NPC context, retrieved
records and Discord/user content belong in `user` messages, never system/developer
roles. The request validator rejects privileged roles in supplied messages, and
the adapter preserves role boundaries without template interpolation. This is
structural separation, not a guarantee against semantic prompt injection. Future
orchestration must enforce authorization, fictional knowledge and disclosure
boundaries. Treat generated text as untrusted data; never execute it. The service
does not render prompts from Context Builder or expose text through Discord.

Accounting and concurrency:

- Input tokens are preflighted using the provider's token-count endpoint on the
  same model/input/tools configuration, not guessed from characters. Failure or
  invalid token metadata prevents generation. Preflight sends supplied content
  to the provider only on explicit invocation; there is no history scraping.
- Before generation, reserve the full priced input plus maximum output cost for
  **all** permitted attempts. The optional configured/caller per-request ceiling
  applies to that full worst case. Prices use exact bigint arithmetic, rounding
  each attempt upward to whole micro-units. No caching discounts are assumed.
- A singleton budget account is locked with PostgreSQL `FOR UPDATE` for every
  reservation/settlement. Its currency cannot silently change, and concurrent
  callers cannot increase its ceiling: the lowest configured ceiling seen is
  retained. Increasing it or changing currency requires deliberate operator
  reconciliation, not merely deploying a more permissive process. All models,
  worlds and service instances share this installation-wide account.
- The UTC month contains settled charges by database settlement time. Reservations
  spanning midnight/month-end remain fully charged until settled. Pending and
  uncertain charges from **any** month also reduce available capacity. This is
  deliberately more conservative than an invoice's billing calendar.
- Successful usage records provider input/output/total tokens and an
  `estimated_from_usage` cost calculated from configured prices, not invoice cost.
  Store price snapshots, provider/model, trace/request IDs, outcome, retries and
  latency; never prompts, output text, credentials or complete response objects.
- Definitive authentication/validation/rate-limit rejections release that attempt's
  unused allowance. Transport errors/timeouts may have been billed, so their full
  per-attempt allowance stays charged. Missing/invalid usage also retains a full
  allowance, explicitly labeled `conservative_reservation`. Known token totals in
  an uncertain request are lower bounds, not fabricated totals for failed attempts.
- Unused, never-dispatched attempts are released at settlement. Abandoned calls
  retain their full reservation indefinitely, including after restart/month-end.
  There is no automatic lease expiry/refund: an operator must reconcile uncertain
  or abandoned records with provider evidence before intentionally adjusting them.
  Settlement failures leave the original full reservation and withhold generated
  text. Unexpected higher reported usage is recorded rather than hidden and blocks
  subsequent requests once the ceiling is reached.
- `getLlmBudgetSummary(db)` reports the account, evaluated liability, lifetime
  known token totals, current UTC-month known tokens/settled estimates, unresolved
  allowances, pending count and unknown-usage count. Per-request observations expose
  cost kind, currency, usage, provider/model, trace, outcome, latency and retry count.

The SDK's own retries/logging are disabled. Generation retries only normalized
connection/408/409/429/5xx transient failures, bounded by the attempt limit and the
overall timeout. Backoff starts at 250ms and doubles, respecting `Retry-After` or
`retry-after-ms`; if guidance exceeds 5 seconds or the remaining deadline, stop
instead of retrying early. Input-token preflight is not retried. Timeout and caller
cancellation abort the transport and stop further attempts, even if a test/provider
ignores abort. PostgreSQL reservation/settlement may still need to finish; a
transport timeout is not a PostgreSQL statement deadline. Unknown server-side
completion remains conservatively charged. Safe diagnostic sink failures cannot
trigger retries or expose provider exception bodies. `store:false`, standard
service tier, no background generation and no tools are explicitly requested;
provider retention/security policies still apply.

Limitations: configured prices must remain accurate; this is conservative local
accounting, not billing reconciliation or a provider-enforced financial guarantee.
It cannot account for requests made outside this installation, taxes, FX, provider
price changes or an API that violates its documented token/output limits. Use
provider project restrictions/alerts too. Streaming, tools, external actions,
multimodal inputs, automatic reconciliation, response orchestration and outbound
messaging are deferred.

Verification: `pnpm quality:gate` and `pnpm test:db`. All provider tests are offline
fakes, including SDK fake-fetch wire tests; no paid requests or live credentials
are used. PostgreSQL tests apply the real new migration in UUID-named fixture
schemas, exercise concurrent independent connections and constraints, then remove
only those fixture tables/schemas. Existing production accounting is untouched.
SDK/API references: [official TypeScript SDK documentation](https://developers.openai.com/api/reference/typescript)
and [input-token counting](https://developers.openai.com/api/reference/typescript/resources/responses/subresources/input_tokens/methods/count).

### M2.7 NPC Response Pipeline

`createNpcResponsePipeline(database.db, environment, safeDiagnosticSink)` from
`src/response/composition.ts` constructs explicit application operations:

```ts
const pipeline = createNpcResponsePipeline(
  database.db,
  process.env,
  diagnostics,
);
const result = await pipeline.generateNpcResponse(
  worldId,
  npcId,
  interactionId,
  {
    context: { maxBytes: 48_000, limits: { knowledge: 12 } },
    maxResponseChars: 2000,
    maxOutputTokens: 512, // may only lower the M2.6 configured cap
    requestBudgetMicros, // optional additional ceiling, not a separate budget
    signal: abortController.signal,
  },
);
// Deliberately invoked by an operator after interruption, never a polling job.
const recovery = await pipeline.reconcileNpcResponse(
  worldId,
  npcId,
  interactionId,
);
```

Import/construction does not generate anything. Startup and Discord intake never
invoke this pipeline. `createNpcResponseOrchestrator(dependencies, diagnose)` is
the transport-neutral injectable service, separate from repositories, Context
Builder and M2.6 generation. It imports no SDK or Discord client. Identifiers must
be UUIDs. `ResponseResult` is success with a persisted interaction and status
`responded`/`already_recorded`, or a normalized failure: `invalid_request`,
`not_found`, `ineligible`, `visibility_blocked`, `context_unavailable`, `claim_lost`,
`invalid_response`, `persistence`, `cancelled`, `generation_failed`. Generation
failures may carry an existing safe M2.6 code, never raw provider/database errors.
Reconciliation returns `not_found`, `not_claimed`, `active`, `responded`,
`reconciled_failed`, `reconciled_uncertain` or `terminal`.

Speech limits default to 2000 characters, configurable from 1–20000 and bounded
again by the domain validator. Context options go to M2.5; oversized prompts fail
before claiming or spending. There is no silent expansion or model switch.

Prompt version `npc-speech-v1` is stored on the claim. Trusted static system and
developer instructions define speech-only behavior, uncertainty, no tools/state
authority, and the exact `{"speech":"..."}` contract. Every retrieved value is
serialized exclusively into user-role JSON, with separate sections for world/game
system, stored NPC persona, current state, permitted beliefs/memories,
relationships, scene/current request and unknown chronology/presence. There is no
default NPC. Baseline identity/summary/personality and stored characteristics are
untrusted self-profile data for characterization, not policy, disclosure grants
or authoritative World Truth. Arbitrary baseline keys, profile source notes,
routing IDs and scene metadata are excluded. Existing manually recorded responses
retain their recorded prompt version, possibly null; provenance is not fabricated.

Conservative access boundary:

- Recheck world/NPC/interaction/context/requester consistency against the original
  interaction and M2.5 snapshot. Require an active NPC and active context.
- The current request requires explicit stored `local` communication mode, a
  linked scene location, and the NPC's independently stored `certain` current
  location matching it. This consumes existing domain assertions, not new
  presence simulation. Discord mappings, mentions and metadata never establish
  this evidence. `unknown`/`remote` requests are blocked without spending or
  lifecycle changes. M2.4 intake normally persists `unknown`, so those requests
  remain blocked until a separately authorized domain workflow establishes valid
  communication. An anonymous speaker is allowed for an otherwise eligible
  request; missing/foreign entities for known speakers fail closed.
- All history is omitted, including same-scene/same-NPC directed messages: these
  records do not establish historical perception. Current location is not proof
  of previous presence. Parallel scenes are not sequenced; game time and scene
  chronology remain unknown. Technical dates exclude later-stored material but
  are never interpreted as game time or fabricated scene timestamps.
- The orchestrator forces M2.5's `history` limit to zero, even if a caller requests
  more, so unperceived history cannot influence term/participant-based relevance.
  Mapped speaker canonical names are withheld: mapping is not proof of the NPC's
  recognition of that character. The current request may contain a self-introduction,
  but that remains an untrusted claim, not confirmed identity.
- All retrieved knowledge is withheld, including public current/disputed claims.
  Existing sources record attribution and labels, not reliable NPC exposure.
  `heard`, `witnessed`, `read`, `official`, requester/NPC identity, source notes,
  Discord routing and storage dates cannot prove perception. Persistence has no
  admissible exposure evidence for these claims; no source type is exempt.
  Whole conflict groups are withheld, preserving world/NPC isolation and avoiding
  partial contradictions. This restriction remains until a future capability can
  represent reliable exposure and disclosure evidence; no exposure data is created.
- All memories and relationship details are omitted: existing records have no
  disclosure classification proving permission to share with the requester.
  Prompt sections remain empty with explicit missing-information labels.
  Internal ownership alone does not authorize disclosure. Archive contents are
  never fetched. Omission counts remain available at the internal filter boundary;
  omitted text is kept only for local validation, never sent to the provider.

These restrictions intentionally sacrifice richness. No permission, exposure or
presence record is invented, and no filter-bypass option exists. The policy uses
an initial consistent snapshot plus authoritative checks at transaction boundaries,
not a dynamic ACL system or proof of historical game chronology. Persona JSON is not semantically verified biography.

Lifecycle and recovery:

- Apply `0011_npc_response_claims` via `pnpm db:migrate`. Five nullable interaction
  claim/audit fields and a shape constraint preserve all existing records. No
  previous migration changes, new tables or world-state schema are needed.
- Lock the scoped interaction, confirm it is unchanged/received with no response
  or previous claim, and use existing `received -> processing` validation. Claim
  ID, database timestamp and prompt version commit together. Competing processes
  cannot claim it. At claim, dispatch and persistence, lock the authoritative
  world/NPC/entity/state/profile/scene rows, rebuild through existing repositories,
  validate current local location and active scene eligibility, and compare all
  prompt-visible sections plus scene/location evidence with the original context.
  Stale context cannot authorize dispatch. Knowledge changes cannot authorize
  content because all retrieved knowledge is withheld.
- An atomic `claimed -> dispatched` fence records intent before M2.6 invocation,
  not proof that HTTP reached the provider. M2.6 invokes an optional application
  authorization callback before token counting (also a provider request) and
  before every generation attempt, including existing bounded retries. These
  short transactions release locks before external calls. There is necessarily
  an interval after each authorization commit in which conditions may change;
  no database lock spans a provider call. A result whose scene, location or
  prompt-visible context is invalid at persistence is withheld and its interaction
  becomes terminal/uncertain; it is never automatically regenerated. Existing
  reservation and settlement run once, including zero generation cost when
  authorization fails after reservation but before a generation attempt.
- Only the matching live claim may persist; immutable response persistence and
  the `responded` audit outcome commit together. Lost/expired claims remain fenced.
- `responded` means generated/validated/persisted, not delivered. No automatic
  completion or Discord response message ID occurs. Responded/completed requests
  return existing text without generation. Failed/processing requests are not
  auto-retried, and previous claims are never cleared to permit regeneration.
- Claims expire after ten technical minutes. Expiry never permits stealing.
  Explicit reconciliation leaves live claims alone; expired processing claims
  transition legally to failed with audit outcome `failed` before dispatch or
  `uncertain` after possible dispatch. A late worker cannot persist afterward.
  Reconciliation is idempotent for terminal records and never overwrites speech.
  There is no scheduler, polling, automatic renewal or automatic regeneration.
  Unclaimed legacy processing records are left to their original workflow.
- Process death/lost acknowledgment can leave a durable claim. On persistence
  errors, inspect the stored interaction first: committed speech is returned,
  never transitioned `responded -> failed`. Failure repositories independently
  lock and guard claim/status/response. If PostgreSQL remains unavailable, retain
  the claim for explicit reconciliation. Recovery never refunds LLM reservations.

M2.6 remains the only generation/budget implementation: token preflight, atomic
full-attempt reservations, fixed priced model/currency checks, deadlines,
cancellation, bounded transient retries and usage settlement. One orchestrator
invocation may include M2.6's bounded retries within the existing reservation; the
pipeline adds no generation/repair retry. Invalid speech still consumed provider
usage; interaction failure does not imply a financial refund.

Validation requires JSON containing only bounded nonempty `speech` and reuses the
domain response validator. It rejects extra tool/action keys, code fences, common
executable/tool markers, control characters, internal UUIDs and common English
claims of DM/system approval. Normalized verbatim matches against omitted
claim/memory/history text (at least eight normalized characters) also reject
speech without sending that withheld text to the model. These guards can reject
innocuous repetitions and cannot detect all paraphrased disclosure, multilingual
approvals or hallucinations. They are not perfect semantic safety or disclosure
authorization. Speech is untrusted text, never executed; future outbound workflows
must enforce their own authorization/knowledge boundaries.

Diagnostics contain only safe event/trace/version/outcome metadata, never prompts,
speech, withheld material, keys or raw errors. Diagnostic sink failures cannot
change persistence. No task acceptance, memory/knowledge/relationship updates,
world-time progression, game mechanics, physical movement, autonomous actions,
Discord outbound messaging, webhooks, avatars or background work are introduced.

Run `pnpm quality:gate`, `pnpm db:migrate`, `pnpm test:db`. Unit tests compose actual
M2.5/M2.6 services with fakes. PostgreSQL tests exercise actual claims, lifecycle,
rollback, concurrent connections, interrupted/late-worker fencing, immutable speech
and domain-state non-mutation. Every provider call uses offline fakes: no paid API
or outbound Discord calls. Cleanup removes only UUID-scoped fixtures created by
the tests, never existing application data.

#### M2.7 review remediation and remaining P2 findings

PR #1's P1 provenance, response lifecycle and PostgreSQL CI findings are addressed
by the conservative restrictions and transaction checks above. No migration is
required; migrations `0000`–`0011` remain unchanged. GitHub Actions retains the
unit/lint/format/typecheck/build quality gate and adds a bounded PostgreSQL 17
service job that applies real Drizzle migrations and executes `pnpm test:db` using
isolated CI-only credentials. Neither job bypasses hooks.

The P2 hardening below addresses the remaining review findings. Provider billing
and context relevance still have the practical limits described here.

Authorization is checked at explicit boundaries, not continuously. Revocations
that occur after a provider request begins cannot retract its input; invalid
conditions still present at persistence prevent saving its output. There is no
historical revocation ledger for detecting a change that is later reverted.
Persona fields remain untrusted characterization, not verified biography.

#### M2.7 P2 hardening

Accounting keeps the existing single atomic account and invocation ledger. The
original `reserved_micros` and truthful `charged_micros` already persist enough
information to detect reservation overruns; no anomaly table or migration is
needed. `getLlmBudgetSummary().usage` now includes all-time `reservationOverruns`
and `reservationOverageMicros`, derived from settled/uncertain ledger rows.
These are not additional charges. Generation observations expose
`reservationMicros`, `reservationOverageMicros` and `estimateExceeded` (an actual
attempt cost above its preflight estimate, even if the all-attempt reservation
absorbs it). Fields contain numeric accounting metadata only. Valid provider
usage is charged even when the response is invalid or exceeds the configured
estimate; no monthly ceiling is automatically increased. After a settlement
failure, output remains withheld and diagnostics retain the greater of known
actual cost and the reservation. The durable reservation remains outstanding;
failed settlement still requires operator reconciliation, not an automatic
refund or second settlement. This remains truthful local accounting, not an
absolute provider-enforced spending limit.

Context retrieval now uses the existing Context Reader/repository boundary with
SQL relevance/status/scope predicates, batched sources, and batched referenced
entities/interactions. History is filtered by world, NPC, scene, technical cutoff
and current-interaction exclusion before its ordered SQL limit. A zero history
limit issues no history query. Candidate claims include the complete recursively
connected conflict closure; cycles terminate through SQL `UNION`. Missing or
ineligible partners still withhold the whole group. More than 500 candidate
claims, conflict edges or relevant memories aborts the build rather than
returning a partial conflict group. This deliberate fail-closed availability
limit applies before output count/byte limits. No source label, relevance match
or SQL existence predicate establishes perception; M2.7 still withholds all
retrieved knowledge, memories and relationship details.

Source window queries fetch at most `max(1, sourcesPerRecord)` rows per candidate
parent and retain exact total/omitted counts. The one metadata row at a zero
source limit is not emitted. Scoped SQL existence checks preserve memory
relevance independently of the provenance output cap. Truncated provenance
remains explicit and never becomes complete exposure evidence. References to
unselected claims/memories are conservatively unavailable. Caches belong to one
reader/build transaction; there is no cache across snapshots or requests.
Retrieval statistics now describe SQL-filtered candidates, not exhaustive
inventories of every NPC record. Output ordering and total byte limits remain
in the existing builder.

Measurements use `src/db/context-performance.db.test.ts`, which creates synthetic
data inside one transaction and rolls it back. The baseline was measured at
`8da788d` before changing retrieval; the same 200-claim/100-memory fixture has
three sources per parent and only 10 relevant claims/five relevant memories.
Read counts exclude fixture setup and transaction control.

| Measurement                         |                 Baseline |              Hardened |
| ----------------------------------- | -----------------------: | --------------------: |
| SQL queries per build (three runs)  |          920 / 920 / 920 |          16 / 16 / 16 |
| Candidate claim/memory rows loaded  |                200 / 100 |                10 / 5 |
| Source rows loaded                  |                      900 |                    45 |
| Local isolated elapsed milliseconds | 346.63 / 304.70 / 287.74 | 35.35 / 23.51 / 21.65 |

The test also grows unrelated claims/memories to 2000/1000 and still requires 16
queries and 10/five returned candidates. CI asserts query/row bounds, not elapsed
time. Run the fixture with
`node --env-file=.env.example --env-file-if-exists=.env ./node_modules/vitest/vitest.mjs run --config vitest.db.config.ts src/db/context-performance.db.test.ts`.
For baseline reproduction, copy that fixture into a temporary checkout of
`8da788d`; its three timing samples precede the expected query-count regression
failure against the new 16-query threshold. No old implementation is duplicated
in production or tests. Historically this fixture required `20 + 3*(K+M)` reads,
plus additional entity and source-interaction lookups for populated references.
The new source batches eliminate those per-record ownership/provenance queries.

Database CPU is not constant: lexical matching still scans scoped text, source
counts/window ordering inspect sources of selected parents, and recursive graph
work grows with reachable conflicts. The 500-candidate guard bounds application
retrieval, not all server work or individual text-column length. Full-text indexes,
search infrastructure, cross-request caches and schema changes were deferred;
blind row limits that split conflict components were rejected. Default source
limits are four, with the existing maximum of 500; at maximum settings, source
payload can still reach 250000 rows per category before the byte-budget filter.

M2.7 now requests a transport-neutral `responseFormat` with the strict
`npc_speech` object schema (`speech` string, required, no additional properties).
The installed OpenAI SDK supports native Responses `text.format` with
`type: json_schema` and `strict: true`, including the token-count request. See
[official OpenAI structured-output documentation](https://developers.openai.com/api/docs/guides/structured-outputs).
The OpenAI adapter advertises structured-output support; another provider must
explicitly advertise it or generation returns `unsupported_output` before any
provider call or reservation. Individual model/schema rejection remains a
permanent normalized provider error: no prompt-only fallback, model switch,
JSON repair or regeneration loop occurs. Refusals and incomplete output fail
closed while preserving usage accounting. The portable provider schema enforces
shape; existing application validation independently enforces character limits,
speech-only content, withheld-text checks and domain constraints. Schema-compliant
text remains untrusted dialogue and is never executed or used to mutate state.

Tests use synthetic providers/fake SDK fetch exclusively. New coverage includes
normal/over/under reservation, actual overruns with uncertain retries, failed and
concurrent settlement, unsupported/refused/incomplete structured output, local
validation despite native schemas, complete cyclic conflicts, inaccessible
partners, candidate overflow, and large/zero-capped provenance. Existing claims,
leases, authorization checks before provider calls, immutable results, recovery
and accounting ownership remain in place. No migrations, provider/model pricing,
Discord delivery, exposure model, autonomous tasks or domain-state writes are
introduced.

### M2.8 Explicit Discord NPC Trigger & Authorized Interaction Intake

M2.8 extends the existing Discord adapter/intake/persistence path. One central
Living World bot receives an explicit request addressed to a registered NPC alias:

```text
<@BOT_ID> [Garak] Check the manifest.
```

`<@!BOT_ID>` is also supported. In Discord, insert a real user mention of the
application bot; typing its display name is not a trigger. The authenticated SDK
client supplies the bot ID separately from normalized message data. Events with
no authenticated client identity are ignored. No bot ID is accepted from message
fields, aliases, mappings or configuration. Literal mention and SDK mention
metadata must agree. Existing exclusions for bot/webhook/system/partial messages,
DMs, unsupported channels/types and edits remain in place. Replies require their
own explicit trigger; reply-author metadata is never a selector.

The pure `parseDiscordTrigger` function requires the leading mention, horizontal
whitespace, one bracketed alias and horizontal whitespace before a nonempty
request. Outer whitespace is trimmed under the existing incoming-message
contract. Aliases cannot contain brackets, line breaks, control/format characters
or exceed 200 characters. Empty and mention-only requests fail closed. Additional
mentions/brackets in the request body are data, never secondary targets. Requests
retain the existing 20000-character trimmed-content bound. Stored `requestText`
remains the complete original trimmed message, including its trigger.

Intake authorization is separate from response authorization. Migration
`0012_context_intake_policy` adds the typed `npc_intake_policy` context column:
`disabled` (the default for every existing and new context) or `mapped_players`.
Visibility, mentions, arbitrary context metadata and identity mappings alone do
not grant permission. There is no per-player/per-scene allowlist anymore.
Remove `DISCORD_INTAKE_ALLOWLIST` from local/deployment configuration: runtime
startup rejects the retired variable rather than silently accepting obsolete grants.

An explicitly enabled context permits only an authenticated Discord author with
exactly one active `player_character` mapping in the resolved world, pointing to
an active entity of type `player_character` in that world. Missing, inactive,
wrong-type or ambiguous mappings fail closed; a primary selection cannot override
multiple active player mappings. Identity provisioning remains a trusted operator
repository/database operation. There is no Discord self-registration or player
policy-management endpoint; do not expose those internal database capabilities to
players. Existing character registrations are reused across approved contexts.

Policy management uses a **local operator CLI**, isolated from the Discord runtime:

```sh
pnpm admin:context-policy --world WORLD_UUID --context CONTEXT_UUID --policy mapped_players
pnpm admin:context-policy --world WORLD_UUID --context CONTEXT_UUID --policy disabled
```

Replace both placeholders with exact UUIDs. All six arguments are mandatory and
in the shown order; wildcards, unknown flags and operator-ID assertions are
rejected before opening a connection. The command reads `DATABASE_URL` from the
operator's private environment/`.env`, verifies the world/context pair, and uses
parameterized operations. It does not connect to Discord or any LLM provider.
Importing the CLI module does not execute it. Neither application startup nor
Discord intake imports or exposes the command.

The authority is trusted host/deployment access and database credentials. Limit
shell access, source execution and database credentials to trusted project
operators; this milestone does not authenticate Admin/DM identities or constrain
such database operators to individual worlds. A Discord role or caller-supplied
operator ID confers no authority. The database is a trusted backend, not a
player-facing API; the CLI is not a sandbox against someone who already has
write-capable database credentials. Never proxy this command to untrusted users.

Each successful command atomically records world/context IDs, previous/target
policy, timestamp and the database role in `context_intake_policy_audit`, including
no-op requests. It prints the audit ID and those policy/ID fields, never credentials
or request content. The database role identifies the database login, not an
individual human if operators share credentials. Errors exit nonzero with a safe
message; if execution/commit confirmation is interrupted, inspect the audit and
current policy before retrying. Audit failure rolls back the policy update.
The composite audit foreign key preserves world/context integrity.

Intake holds `FOR SHARE` on the resolved context through interaction commit. The
CLI takes `FOR UPDATE` on that same row through policy/audit commit. Revocation
therefore waits for earlier authorized intake to commit or roll back; intake that
follows a committed disable observes `disabled` and cannot persist a new event.
No instance restart is required. This guarantee lasts until an operator explicitly
re-enables the context. Both operations use two-second lock and five-second
statement timeouts; lock failure rolls back rather than bypassing checks.

Provision mappings and aliases explicitly through the existing repositories:

```ts
await addEntityAlias(database.db, worldId, npcId, { alias: "Garak" });
```

The existing alias normalizer trims, lowercases and collapses whitespace. Resolve
only registered aliases in the world selected from active Discord mappings. A
canonical name or baseline-profile alias is not automatically registered. Exactly
one distinct entity must match, and it must be an active NPC entity/profile.
Same-world collisions, including inactive or non-NPC entities, are rejected;
there is no preferred winner, fuzzy matching, canonical fallback or global alias
uniqueness constraint. Identical aliases across different worlds remain valid.

`createDiscordIntake` defaults to `explicit_alias`; `startApplication` explicitly
selects that mode and uses the existing Discord persistence adapter. The
foundation's `mapped` mode is an explicit trusted compatibility
API for existing primary/operator routing, not a runtime fallback or a public
authorization endpoint. The runtime never falls back to it. Do not run legacy
receivers alongside strict receivers for the same bot if relying on M2.8 policy.
No second intake service, generic permission framework, queue or scheduler exists.

The existing persistence transaction now handles authoritative explicit routing:

1. Revalidate the normalized message and authenticated-bot trigger. Serialize the
   guild/parent-channel location, then lock matching mapping rows and their worlds.
   Exactly one active world must match; cross-world ambiguity is rejected even
   when one world has an exact thread mapping.
2. Reuse exact-thread-before-channel context resolution. Lock and require the
   resolved active context; an inactive exact context never falls back to a
   different scene. Require the persisted `mapped_players` policy under the same
   context lock.
3. Serialize the scoped source event and existing author-identity writers. Lock
   identity/entity rows and require exactly one active player-character mapping
   with a valid active player-character entity in this world. There is no primary
   fallback or unknown-speaker admission in strict intake; NPC operator mappings
   do not authorize player intake or fabricate NPC speech identity.
4. Serialize alias registration/resolution and lock matching alias/entity rows
   plus the target NPC profile. `addEntityAlias` and `mapDiscordContext` cooperate
   with the same advisory-lock patterns, protecting new alias/mapping insertions
   even when no matching row existed previously. Active status is checked inside
   the transaction; no channel or primary space becomes a physical location.
5. Lock up to two existing interaction rows for this world's Discord event.
   Exactly one matching target/context/speaker/original request yields `duplicate`
   without changing its trace, text, lifecycle, claim or response. Conflicting
   routing or legacy multi-target events yield `event_conflict`; reassigned aliases
   cannot create another NPC interaction on retry. Removed/ambiguous/inactive
   aliases also fail without altering the original interaction.
6. For a new eligible event, call the existing `createInteraction` repository with
   one target, `received` status, `social` type, `unknown` communication mode,
   provider `discord`, original source ID and trace. Existing database uniqueness
   and immutable response/lifecycle behavior remain unchanged.

Lock waits are limited to two seconds and statements to five seconds in the
strict transaction. A database/lock failure rolls back and returns safe `error`;
there is no automatic retry queue. Scope locks are short database operations and
never span an external provider call. Diagnostics contain fixed outcome codes,
not messages, aliases, identities, policy configuration or raw database errors.
Other outcomes include `invalid_trigger`, `unsupported`, `unmapped`,
`ambiguous_world`, `unauthorized`, `ambiguous_speaker`, `ambiguous_target`,
`invalid_target`, `accepted`, `duplicate` and `event_conflict`.

Limitations are explicit: uniqueness/retry binding remains scoped to the world
and existing per-NPC event contract. Reassigning a Discord location to a different
world during redelivery can create an independent interaction there; there is no
global event receipt or cross-world immutability guarantee. Operator SQL that
inserts aliases/mappings must honor the same locking protocol when intake runs;
application repository writes coordinate automatically. Same-location strict
intake is serialized, and the cross-NPC event lookup uses existing indexes; this
is a small bounded transaction design, not a high-throughput routing platform.
Migration `0012` adds only the context policy enum/column and its audit table;
`0000`–`0011` and their checksums remain unchanged.

M2.8 does not call M2.7. An accepted trigger is permission to record intake, not
permission to generate a response. `unknown` communication remains blocked by
M2.7 before token counting, budget reservation or generation, even when independent
stored location evidence happens to match. Nothing changes NPC location,
perception, knowledge, memories, relationships, tasks or world time. No Discord
outbound/webhooks, passive perception, autonomous actions, archive synchronization,
background scene monitoring, paid/live test calls or deployment are introduced.

Verification uses parser/config/adapter/runtime and local-CLI unit tests plus
`src/db/discord-trigger.db.test.ts` and `src/db/context-intake-policy.db.test.ts`
against real PostgreSQL. Tests cover disabled defaults for preexisting/new
contexts, invalid and read-only administrative operations, audit atomicity,
strict mapped-player eligibility, alias collisions/normalization, world isolation,
thread precedence, concurrent redelivery, alias reassignment, immutable terminal
interactions, both revocation/intake orders, identity deactivation, cooperating
alias/mapping insertion and the unknown-mode M2.7 generation boundary. All
transports/providers are offline fakes;
PostgreSQL cleanup removes only UUID-scoped fixtures created by the suite. Run
`pnpm quality:gate`, `pnpm db:migrate`, `pnpm test:db`, Drizzle integrity/drift
checks and `git diff --check` before independent review.
