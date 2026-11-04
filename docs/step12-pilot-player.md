# Step 12 — Pilot player enrollment and revocation (offline operator only)

**Status:** Draft implementation; no local enrollment, policy change or live Discord test is authorized by creating this PR.

## Scope

The operator can inspect, enroll **one** private test Discord user into the already provisioned synthetic pilot player-character, and later revoke the mapping. It operates only on `lw-dev-pilot-001` on the dedicated local PostgreSQL 17 database, with strict guards and no Discord network access.

The original `lw-dev-gateway-001` fixture remains pristine. The pilot already exists with world `585b48b9-9160-4366-9312-455c39551302`, context `3608a56c-2597-4df9-b749-b37b7d7cdace` and NPC `c3478581-b6fb-478c-85d0-9c0b3868ea3c`. Pilot DEV route: guild `1566911648701223053`, independent parent `1567604837309350030`, thread `1567605016603271208`. These UUIDs are operator-local references, **not hardcoded deployment targets**; the CLI looks up the world key and validates the exact configured route.

The operator confirmed the thread location and bot read-only effective permissions in the Discord UI; this is not an independent API audit. No bot permission changes are needed for the offline enrollment stage.

## Why there are two separate gates

- A mapped Discord user does **not** authorize NPC intake alone. Pilot scene `npc_intake_policy` must separately be `mapped_players`, with its own operator approval and audit. This Step 12 tool **never enables policy**.
- Even the authorized enrollment command refuses to write if policy is not currently `disabled`. Revoke also requires policy `disabled`, ensuring fail-closed teardown.
- No general per-user whitelist is introduced; mapping is a world-scoped player-character identity, and only one synthetic pilot test identity is supported.
- This is a local operator command, never a Discord slash command, API endpoint, runtime handler, or autonomous DM instruction.

## Strict safety rules

The command requires existing `.env.gateway-dev.local` and `.env.gateway-pilot.local` (both Git-ignored). It validates the dedicated DB at `127.0.0.1:55432/living_world_gateway_dev`, role `lw_gateway_dev`, PostgreSQL 17, and flags `DISCORD_ENABLED=false`, `DISCORD_OUTBOUND_ENABLED=false`, `LLM_PROVIDER=disabled`. No production environment or remote DB is permitted. It requires an exact separate parent/thread, active test world/scene, one scene mapping, the unique synthetic player character and NPC, and no unexpected Discord identity rows.

The **test-user ID is not passed in CLI arguments** (avoid shell history and PR comments). Select one human user from the private DEV guild, never a bot/webhook account. Keep the ID in an additional local ignored file `.env.gateway-player.local`, permissions `0600`:

```dotenv
LW_PILOT_TEST_USER_ID=<private-human-test-user-id>
```

Never paste this file, Discord bot token, DB URL/password or actual RP message content into GitHub, Notion or chat. The operator is responsible for confirming the user is a human authorized to act as the temporary test player. The CLI checks the ID shape and rejects the bot and route IDs but cannot authenticate the user without Discord API.

## Commands after reviewed PR merge (do not execute writes before separate consent)

First check out the latest merged `main`, preserve both existing local .env files, and run read-only preview:

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-pilot.local --env-file=.env.gateway-player.local --import tsx src/admin/discord-pilot-player.ts --preview
```

Expect event `pilot_player_preview` with `policy:"disabled"`, `identityStatus:"absent"` and the original pilot world/context IDs. No user ID, token or message text is logged.

**Enrollment is a persistent DB write and requires a separate explicit owner go-ahead**, after reviewing the preview:

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-pilot.local --env-file=.env.gateway-player.local --import tsx src/admin/discord-pilot-player.ts --enroll --confirm-world lw-dev-pilot-001 --confirm-database living_world_gateway_dev
```

Expected event `pilot_player_enrolled`. Re-running enrollment returns `pilot_player_already_enrolled` without duplicating rows; an inactive prior mapping causes a safe stop, never silent reactivation. It adds only one `player_character` identity mapping; **NPC intake stays disabled**. Once the pilot is enrolled, the strict pilot fixture `already_present` check is expected to reject legitimate identity drift; from this point use the **new pilot-player preview** instead of repeating the pristine fixture command for pilot. The _original_ fixture must still report `already_present`.

After a **separately approved live** pilot (not part of this PR), first change the pilot scene policy to `disabled` via an audited, pilot-scoped operator gate. Then revoke the test identity using:

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-pilot.local --env-file=.env.gateway-player.local --import tsx src/admin/discord-pilot-player.ts --revoke --confirm-world lw-dev-pilot-001 --confirm-database living_world_gateway_dev
```

Expected event `pilot_player_revoked`, followed by preview `identityStatus:"inactive"`. The mapping is deactivated, not deleted, retaining its created/updated timestamps; a dedicated identity audit table is not added by this PR. The existing `context_intake_policy_audit` separately captures scene policy changes.

## Automated acceptance

Unit tests cover exact CLI confirmation, ID/route validation, blocked network/LLM flags, and privileged DB denial. Isolated real PostgreSQL integration tests cover preview, one authorized mapping, idempotent replay, intake still unauthorized with policy disabled, revocation, attempted reactivation denial, wrong-thread rejection, zero interactions/deliveries and preservation of the original world. CI checks remain mandatory.

## Not covered or authorized by Step 12

- Granting a real Discord player any permission, enabling `mapped_players`, or writing to the owner's local DB now.
- A live Gateway login, privileged `MessageContent` intent, message collection, response generation, outbound sending, LLM, paid calls or Hetzner deployment.
- Durable mapping-change audit records beyond the identity row status/timestamps. This is a deliberately small DEV-pilot-only tool, not a general player onboarding system or permanent allowlist.

**Next gate:** code review and passing CI, owner-approved merge, then privately choose one human DEV Discord test account and run read-only preview. Local enrollment and scene policy changes require their own explicit approvals.

## Local preview deprecation warning and regression guard

After the first owner-run read-only preview, PostgreSQL returned the correct `pilot_player_preview` (`policy:"disabled"`, `identityStatus:"absent"`) but node-postgres emitted a deprecation warning about `client.query()` while another query was still executing. The initial Step 12 helper launched independent `Promise.all` selects inside one transaction, which shares **one physical pg client**; that concurrency is unsupported in newer `pg` releases.

The follow-up patch replaces these batches with serial `await` calls **without changing any SQL conditions, row mutations, permissions, policy, or pilot identifiers**. A focused PostgreSQL integration regression wraps one dedicated checked-out pg client and rejects _any_ overlapping query during preview/enroll/revoke. Run all CI jobs before authorizing an operator-side enrollment.

Once this fix is merged, repeat only the read-only `--preview` command. Expected result remains `pilot_player_preview` with `identityStatus:"absent"` and `policy:"disabled"`, but **without** the pg deprecation warning. Do not run `--enroll` until the fixed preview and a separate owner approval are confirmed.
