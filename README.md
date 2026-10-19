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
NPC primary spaces are not world locations or physical presence. Discord
integration itself is not implemented yet.

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
