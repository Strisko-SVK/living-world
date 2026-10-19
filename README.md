## Development

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
