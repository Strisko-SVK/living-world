# Step 13 — Pilot-only NPC intake policy gate (offline, audited, reversible)

**Status: proposed, code in Draft PR.** No owner approval to enable NPC intake, run Gateway, send messages or access a paid LLM. The existing single-test-player mapping was already enrolled by the operator and independently checked via read-only pilot-player preview. The NPC intake policy remains **disabled** until a later, specifically approved operator action.

## Isolation and authority

This is a **local operator-only** CLI, not an HTTP/Discord/LLM endpoint. It changes only the one synthetic pilot scene for `lw-dev-pilot-001` on local `living_world_gateway_dev` PostgreSQL 17. The original pristine world `lw-dev-gateway-001` and its channel remain out of scope.

The CLI requires the existing Git-ignored `.env.gateway-dev.local` and `.env.gateway-pilot.local`. For **enable only**, it additionally requires `.env.gateway-player.local` containing the privately chosen `LW_PILOT_TEST_USER_ID`—do not paste the Discord user ID, credentials, API tokens or private RP text into chat, Notion, PRs or logs. **Disable does not depend on a player ID**, so an urgent rollback remains possible if the private player file is missing.

At runtime the CLI checks:

- `DISCORD_ENABLED=false`, `DISCORD_OUTBOUND_ENABLED=false`, `LLM_PROVIDER=disabled`; loopback `127.0.0.1:55432`, DB name `living_world_gateway_dev`, role `lw_gateway_dev` (non-superuser), PostgreSQL major 17 and nonproduction environment
- Exact world key, one active scene, its DEV guild, separate pilot parent/thread, and one nonambiguous active scene mapping in the database; no original parent reuse or conflicting cross-world route
- On enable: exactly one enrolled **active** test human mapped to `Gateway Test Character`, the expected synthetic Sentinel NPC, no prior pilot interactions/deliveries, `policy=disabled`, and zero previous policy audit events
- On any write: explicit **pilot world, context UUID and DEV database** confirmations in the command, serialized transaction locks; audit record and policy change are committed atomically

No new migration is needed. It reuses the pre-existing `context_intake_policy_audit` schema, preserving previous/target policies, database role and timestamp.

## First: read-only policy preview, after approved PR merge

Update `main` locally and run:

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-pilot.local --import tsx src/admin/discord-pilot-policy.ts --preview
```

Expected on current owner pilot: `event="pilot_policy_preview"`, world `585b48b9-9160-4366-9312-455c39551302`, context `3608a56c-2597-4df9-b749-b37b7d7cdace`, `policy="disabled"`, `identityStatus="active"`, `policyAuditEvents=0`. No database writes or Discord login occur.

## Enable: only after a separate owner approval

Enabling policy creates a new permission to **persist** eligible Discord intake when a separately authorized Gateway worker is eventually started. It **does not** start the worker, open the Gateway, send replies, use privileged MessageContent, run LLM or deploy anything. Enable is a **single-use pilot transition**: if the pilot already has policy-audit history, it rejects another enable rather than silently recycling a previously used scene.

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-pilot.local --env-file=.env.gateway-player.local --import tsx src/admin/discord-pilot-policy.ts --enable --confirm-world lw-dev-pilot-001 --confirm-context 3608a56c-2597-4df9-b749-b37b7d7cdace --confirm-database living_world_gateway_dev
```

Expected: `event="pilot_policy_changed"`, `previousPolicy="disabled"`, `policy="mapped_players"`, with a new audit UUID. Re-run read-only preview; expect `policy="mapped_players"`, one active identity and `policyAuditEvents=1`. Preserve the audit UUID and do not treat approval to enable policy as approval for Gateway login or actual intake.

## Emergency disable / rollback (separate, fail closed)

Even if the mapped player's identity is unexpectedly inactive or the private player env file is lost, this command can turn off intake in the exact approved pilot context, with a second audit event. It never attempts to enable NPC responses, remove historical interactions or delete the identity.

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-pilot.local --import tsx src/admin/discord-pilot-policy.ts --disable --confirm-world lw-dev-pilot-001 --confirm-context 3608a56c-2597-4df9-b749-b37b7d7cdace --confirm-database living_world_gateway_dev
```

Expected after a successful earlier enable: `previousPolicy="mapped_players"`, `policy="disabled"` with a second audit UUID. Repeated disable is idempotent and creates no new audit. A re-enable attempt on an already activated pilot is rejected pending human review.

For complete teardown, **first disable policy** and then use the separately owner-approved Step 12 `discord-pilot-player.ts --revoke` to mark the test mapping inactive, without deleting history.

## Acceptance tests

Unit tests verify exact confirmation flags, rejection of unsafe DB/runtime/route, no private player ID requirement for emergency disable, and privileged DB denial. Real PostgreSQL integration tests prove: initial deny, active identity still denied while policy disabled, incorrect context cannot be enabled, audited activation allows a synthetic accepted intake, disabling blocks subsequent intake, idempotence/no duplicate audit, no re-enable after history, emergency disable after unexpected player revocation, and pristine original fixture unchanged.

**Mandatory gates:** PR code review and all CI jobs PASS, explicit owner approval to merge, successful owner-run read-only preview, separate explicit owner approval for `--enable`, and a still later separate approval for bounded inbound-only Gateway. No outbound, MessageContent assumption, LLM, paid API or production deployment is part of Step 13.
