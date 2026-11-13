# Isolated local Gateway DEV database

This is a **separate local PostgreSQL 17** used only for the synthetic Living World Gateway fixture. It does not start the Discord bot, deploy anything, send messages, bind real users, or call an LLM. The existing root `docker-compose.yml` has different credentials and a broadly published DB port: **do not use it for this step**.

## Preconditions

Use Node.js 22, pnpm and local Docker Desktop/Engine with Docker Compose. Run `pnpm install --frozen-lockfile` in the checkout. Verify Docker points to **your own computer**, not the production VPS, SSH, a remote Docker host or a forwarded socket:

```bash
docker context show
docker context inspect
```

A localhost URL alone cannot prove the underlying instance is local. If uncertain, stop before proceeding.

## 1. Generate private local credentials

```bash
node --import tsx src/admin/gateway-dev-db.ts init
```

This creates `.env.gateway-dev.local` with two different random 256-bit passwords, file mode `0600`, and disabled Discord/outbound/LLM flags. It refuses to overwrite existing credentials. The repo's `.gitignore` excludes `.env.*`. Never paste or upload this file, including to chat, Notion, CI logs or GitHub.

Open it **locally** and fill only `LW_DEV_GUILD_ID`, `LW_DEV_PARENT_CHANNEL_ID` and `LW_DEV_THREAD_ID` using the nonsecret IDs in [Notion document 10, section 8](https://app.notion.com/p/40c013906e7181b392f3ec93e3f8da91). Keep `DISCORD_ENABLED=false`, `DISCORD_OUTBOUND_ENABLED=false` and `LLM_PROVIDER=disabled`.

## 2. Start the isolated local database

```bash
docker compose --env-file .env.gateway-dev.local -f compose.gateway-dev.yml config --quiet
docker compose --env-file .env.gateway-dev.local -f compose.gateway-dev.yml up -d --wait
docker compose --env-file .env.gateway-dev.local -f compose.gateway-dev.yml ps
node --env-file=.env.gateway-dev.local --import tsx src/admin/gateway-dev-db.ts check
```

Inspect Compose `ps`: the **only** published DB binding must be `127.0.0.1:55432->5432/tcp`. The check verifies the actual database/role, ownership, PostgreSQL 17 and non-superuser, no-CREATEDB/no-CREATEROLE privileges. A reused or incompatible volume must be investigated, not silently repaired.

> **Existing populated Gateway DEV database (M2.15F / migration 0018):**
> This section's generic `migrate` command is intended for the initial
> database setup. If the isolated local volume already contains the
> consumed Sentinel NPC E2E fixture, **do not rerun it without the separate
> owner approval for migration 0018**. Follow the [read-only migration
> preflight and private backup procedure](m2.15f-migration-0018-handoff.md).
> It must verify that *only* 0018 is pending before the write operation.

## 3. Run migrations and preview (no fixture data write)

Only after both the Docker context and DB identity have been verified:

```bash
node --env-file=.env.gateway-dev.local --import tsx src/admin/gateway-dev-db.ts migrate
node --env-file=.env.gateway-dev.local --import tsx src/admin/discord-dev-fixture.ts
```

The empty-DB preview should return `{"status":"would_create","worldKey":"lw-dev-gateway-001"}`. Do not change the global `.env` file or reuse shared development data.

## 4. Apply only after separate owner approval

Seeding this **persistent local test database** is a separate gate from merging code. Once approved for this exact verified DB:

```bash
node --env-file=.env.gateway-dev.local --import tsx src/admin/discord-dev-fixture.ts --apply --confirm-database living_world_gateway_dev
node --env-file=.env.gateway-dev.local --import tsx src/admin/discord-dev-fixture.ts
```

The first result is `created`, the second `already_present`; world/context/NPC IDs are stable. Intake remains disabled and no Discord identity, local presence, interaction, delivery or generated text is created.

## Stop safely

```bash
docker compose --env-file .env.gateway-dev.local -f compose.gateway-dev.yml stop
```

Stopping retains the dedicated volume. Do **not** run `down --volumes` or delete the credentials/data without separately deciding to dispose of this isolated test environment.

## Automated verification

The unit suite checks generated secrets, local-only config validation and privilege restrictions. A dedicated GitHub Actions job starts this isolated Compose service on an ephemeral runner, verifies identity and migrations, and tests offline preview/apply/replay using synthetic Discord IDs. The CI job removes only its own disposable container/volume, without any live Gateway or paid calls.
