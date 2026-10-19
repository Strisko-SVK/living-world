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
