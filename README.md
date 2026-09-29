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
