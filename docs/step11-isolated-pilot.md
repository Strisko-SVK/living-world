# Step 11 — Isolated Discord pilot world (offline provisioning only)

**Status:** Draft implementation and tests, not authorized for local apply, live Discord login or player enrollment.

## Why a second parent channel is mandatory

Step 8's pristine fixture lives at world `lw-dev-gateway-001`, parent channel `1566913668795469934`, and thread `1566914038158459090`. Its strict replay checks all routed mappings for its **guild + parent** and rejects a second mapping there even if the thread is different. Therefore a new thread under `#rp-test-scene` is **not** enough. Create a separate **private parent channel** (proposed `#rp-pilot-scene`) and a separate test thread inside it. The same private Living World DEV guild may be reused.

The new pilot world key is `lw-dev-pilot-001`. It reuses the existing tested `provisionDevFixture` implementation with a different world key and a different parent/thread route; the synthetic NPC alias is `Sentinel`, and its player-character entity has **no Discord identity mapping**. **Intake starts disabled**; there are no interactions, responses, deliveries or LLM invocations.

## Mandatory Discord permissions preflight (owner-operated, not done by this PR)

- Create `#rp-pilot-scene` as a new private text parent channel in Living World DEV, plus a dedicated thread within it. Do not reuse the Step 8 parent, thread, or any production guild. Prefer a dedicated private category with no untrusted members.
- Keep the bot offline while provisioning the channel. Initially only the owner and authorized DEV DM should have access. Verify the effective bot role permissions before any future inbound test: **View Channel** and access to test thread, but no Administrator, send, manage, webhook or cross-channel permissions. Never grant access to `#dev-control`.
- Record **only nonsecret** IDs in the private project handoff; never paste bot token, `.env`, passwords or real RP content.
- The user account used for a later *live* player mapping is a separate approval; do not add `discord_identities`, change `npc_intake_policy` or run the normal runtime as part of this provisioning.

## Operator preflight (after code is reviewed/merged; separate approval before apply)

Reuse the existing dedicated local PostgreSQL 17 instance and original private `.env.gateway-dev.local`, without changing it. Git ignores `.env.*`. Create another local ignored file `.env.gateway-pilot.local` with only these nonsecret values:

```dotenv
LW_PILOT_PARENT_CHANNEL_ID=<new-pilot-parent-channel-id>
LW_PILOT_THREAD_ID=<new-pilot-thread-id>
```

The CLI inherits the DEV guild ID from `.env.gateway-dev.local` and rejects any other guild, original parent/thread ID reuse, remote database, privileged DB role, production mode, enabled Discord, outbound or LLM.

Check original baseline:

```bash
node --env-file=.env.gateway-dev.local --import tsx src/admin/gateway-dev-db.ts check
node --env-file=.env.gateway-dev.local --import tsx src/admin/discord-dev-fixture.ts
```

The second output must be `already_present` with the original three UUIDs; STOP otherwise.

Preview the pilot (nonmutating):

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-pilot.local --import tsx src/admin/discord-pilot-fixture.ts --preview
```

On a clean pilot route, expect `{"status":"would_create","worldKey":"lw-dev-pilot-001"}`. This preflight performs read-only database checks but does not create data, contact Discord or send messages.

**Do not execute this next command merely because it is documented.** Only after explicit owner permission to create persistent pilot DB rows, and after reviewing the preview:

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-pilot.local --import tsx src/admin/discord-pilot-fixture.ts --apply --confirm-world lw-dev-pilot-001 --confirm-database living_world_gateway_dev
```

This writes only synthetic pilot world, location, NPC, player-character, scene and route records to the existing dedicated DEV DB. It never enables NPC intake, maps a Discord player or sends a message. Immediately repeat pilot preview and original fixture preview: both should be `already_present`. Stop if either fails.

## Later security gates — not included here

1. Produce a separate audited, reversible test-only operator procedure for binding exactly one authorized Discord test user to the pilot player-character. Never use a permanent global user allowlist.
2. Explicitly enable `mapped_players` **only on the pilot scene**, record an audit trail, and verify denied messages everywhere else.
3. Design a short inbound-only Gateway test that uses the actual message body/mention, no outbound or LLM, and persists exactly one `received` interaction in the **pilot** world. Verify no deliveries and no unexpected data.
4. Disable pilot intake immediately afterwards, deactivate the test mapping and design careful, scope-bound cleanup/archive. **Do not delete/modify the original Step 8 world.** The strict pilot `already_present` preview is expected to reject later legitimate enrollment/policy history; use an audit/status report after authorization tests instead, rather than assuming it remains pristine.

No live connection, live message, token handling, deployment, paid provider or real player provisioning occurs in this Step 11 fixture PR.
