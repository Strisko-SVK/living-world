# Step 14 — Single-message pilot Discord Gateway intake (inbound-only)

**Status: Draft PR implementation. No live login, owner-local execution, Discord send, LLM, deployment or merge authorized by creating this code.**

## Why a new standalone entry point

Step 9's `discord-gateway-smoke.ts` observes **metadata only** on the original pristine thread, with no persistence. Do not run that smoke as if it tests Step 14. The normal `src/index.ts` also starts more subsystems than this narrowly bounded test should ever use. Step 14 adds `src/admin/discord-pilot-gateway.ts`, which connects **only after explicit owner authorization** and reuses the established `normalizeDiscordMessage` + `createDiscordIntake(createDiscordPersistence(db))` path **without response generators, delivery clients, webhooks or LLM**.

Discord's official [Gateway message-content documentation](https://docs.discord.com/developers/events/gateway#message-content-intent) identifies direct app mentions as an exception to privileged MessageContent restrictions. This test requests **only** `Guilds` and `GuildMessages`, not `MessageContent`. Whether the app receives the required direct-mention content in the owner's actual DEV server must still be proven with the first separately authorized test; otherwise the 90-second timeout fails closed.

## Exact isolated pilot scope and current state

- Existing private DEV guild: `1566911648701223053`
- **Pilot-only parent:** `1567604837309350030`
- **Pilot-only thread:** `1567605016603271208` (public thread inside the *private parent*)
- Expected bot/application ID: `1566909036899868712`
- Local synthetic world: `lw-dev-pilot-001` / `585b48b9-9160-4366-9312-455c39551302`
- Pilot scene/context: `3608a56c-2597-4df9-b749-b37b7d7cdace`
- Pilot synthetic NPC: `c3478581-b6fb-478c-85d0-9c0b3868ea3c` / alias `Sentinel`
- Single authorized test human's mapping: `7f4d41ee-82fc-4694-aa79-098faf455413`; the real Discord User ID is **private** and remains only in `.env.gateway-player.local`
- Owner-approved Step 13 `mapped_players` activation audit: `2b95f215-1a22-4d25-9f62-fe15341d7af6`; read-only preview reported `identityStatus=active`, `policyAuditEvents=1`
- Original **untouched** Step 8 world: `lw-dev-gateway-001` / `abfc527c-f5db-4294-8452-7eeb1ad7829a`

No runtime is currently running merely because the pilot policy has been enabled. The policy is a stored authorization prerequisite, not an instruction to boot the bot or generate a response.

## Offline-only preflight after reviewed/approved PR merge

A bot token must be obtained privately into the Git-ignored `.env.gateway-smoke.local` (from Step 9, with `LW_DEV_BOT_USER_ID` and `DISCORD_TOKEN`). Never send the token, player ID, SQL/DB URL or file contents to chat/Notion/GitHub. Also keep `.env.gateway-dev.local`, `.env.gateway-pilot.local` and `.env.gateway-player.local` Git-ignored and restricted to the local operator.

The configuration must keep `DISCORD_ENABLED=false`, `DISCORD_OUTBOUND_ENABLED=false`, `LLM_PROVIDER=disabled`, `NODE_ENV` nonproduction, and PostgreSQL 17 local at `127.0.0.1:55432/living_world_gateway_dev` as non-superuser `lw_gateway_dev`.

After CI and an owner-approved merge, run **only** the following read-only validation on updated main:

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-pilot.local --env-file=.env.gateway-player.local --env-file=.env.gateway-smoke.local --import tsx src/admin/discord-pilot-gateway.ts --preflight
```

Expected safe output: `{"event":"pilot_gateway_preflight_valid"}`. It performs no Discord login, network send, database mutations, migration, or LLM call. It validates exact DB role/major, synthetic world/context/route, single active mapped human, Sentinel, the **one recorded authorization audit**, zero prior pilot interactions, zero deliveries/presence and original-world pristine state. It rejects any previously consumed pilot so the same test cannot replay into a used world.

## Live one-shot test — NOT AUTHORIZED by this PR or by local preflight

**Only after a separate explicit owner approval for the actual Discord Gateway login and one real inbound message:**

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-pilot.local --env-file=.env.gateway-player.local --env-file=.env.gateway-smoke.local --import tsx src/admin/discord-pilot-gateway.ts --connect --confirm-world lw-dev-pilot-001 --confirm-context 3608a56c-2597-4df9-b749-b37b7d7cdace --confirm-guild 1566911648701223053 --confirm-database living_world_gateway_dev --inbound-only --one-message
```

After output `{"event":"pilot_gateway_ready"}`, **only the mapped owner-controlled test account** may send exactly **one** benign message in the pilot thread:

```text
<@1566909036899868712> [Sentinel] Report readiness.
```

A literal Discord mention should be typed/selected such that the bot is actually tagged (and the SDK `mentions.users` includes the bot). The CLI also permits `<@!bot-id>` as the direct-mention representation, but rejects any other text, actor, thread, channel, guild, webhook, bot/system event or reply. These rejected events are not persisted or logged. The first eligible event synchronously latches, so duplicate Gateway callbacks cannot start a second write.

Expected safe log events, without any message text, author ID, message ID, token or credentials: `pilot_gateway_ready`, `pilot_gateway_received`, `pilot_gateway_audit_pass`, `pilot_gateway_stopped`, and `pilot_gateway_complete`. The last two rely on real database postflight verification that **exactly one** received interaction is scoped to the pilot world/context/NPC/player and matching source Discord route/event; response text/claims, deliveries and local presence must be absent, and original world must be pristine. The bot destroys its Gateway client after one accepted event; errors, bad identity, disconnect or a 90-second timeout terminate safely and print only `pilot_gateway_failed_safely`.

Do **not** post the Discord token or actual message/event IDs to the chat. On failure, do not retry automatically. The pilot may already contain one committed interaction; an operator must inspect/audit before another attempt.

## Safe halt and one-shot rollback

The CLI only closes the connection; it deliberately **does not automatically change intake policy** or revoke identity on a network error because those are separate audited operator writes. For an authorized halt **after the live test**, disable the pilot intake (separate exact-world/context/database write):

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-pilot.local --import tsx src/admin/discord-pilot-policy.ts --disable --confirm-world lw-dev-pilot-001 --confirm-context 3608a56c-2597-4df9-b749-b37b7d7cdace --confirm-database living_world_gateway_dev
```

Then run the policy's read-only `--preview`, expecting `policy=disabled`, `policyAuditEvents=2`. The Step 12 player `--revoke` may be used only after policy is disabled and with separate owner approval. **Rollback is intentionally not reversible automatically:** Step 13 prohibits a second `--enable` if policy audit history exists. Design any future repeat test with a new approved pilot world or reviewed recovery plan.

## Automated acceptance and boundaries

Unit tests use an **offline fake Discord client** to verify exact configuration, one-message latch, wrong-guild/thread/author/content rejection, direct-mention filtering, timeout, disconnect and cleanup. PostgreSQL tests use only uniquely generated synthetic world IDs/routes; they activate synthetic policy/identity, pass one synthetic event through the existing normalization and intake layer, assert the strict before/after audits, deduplication and idempotence, then disable policy and verify subsequent events are unauthorized and the original synthetic baseline remains pristine.

**Never** use `src/index.ts`, enable `MESSAGE_CONTENT`, send/reply/edit messages, contact the LLM, enable outbound, run a webhook, or deploy to Hetzner as part of this test. No new migration is needed. Required gates: all CI, code review, explicit **merge** approval, operator **read-only preflight**, then a new explicit approval for **live Gateway connection and one benign test message**, then post-run audit and separately approved teardown.
