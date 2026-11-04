# Step 10 — Offline authorized Discord NPC interaction verification

**Status:** Draft test evidence only. No actual Gateway connection, player enrollment, LLM, outbound messages, or Hetzner deployment.

## Goal and boundary

The existing main runtime receives explicitly addressed Discord messages, validates the exact world/context/scene route, checks an explicit context intake policy and mapped player identity, resolves an NPC alias, and persists one interaction. This step verifies that path offline with a *synthetic* Discord event and real isolated PostgreSQL. It deliberately does not use Discord HTTP, Discord Gateway, network access, the operator's local sentinel world, or an LLM.

**Critical:** The previously provisioned persistent world `lw-dev-gateway-001` and NPC `Sentinel-001` are a clean Step 8 fixture: its replay validator rejects extra identities, policy history and interactions. Do **not** enable `mapped_players` or map a Discord user on that world merely to test Step 10, because its `already_present` acceptance would then fail. Step 10 tests create their own UUID-scoped synthetic world and route and clean up only those test-owned rows.

## First offline integration case

With the actual repositories and PostgreSQL schema, for one synthetic world, one scene mapped to a synthetic thread and one NPC `Sentinel` with registered alias:

1. Begin with policy `disabled`, no identity binding, no interactions/outbound. A correctly shaped mention+alias message must be rejected as `unauthorized`.
2. Create a synthetic mapping from a fake Discord author ID to the synthetic player-character entity. The same message must *still* be rejected while policy is `disabled`.
3. Change this synthetic context policy to `mapped_players` through the existing operator command, including the policy audit record.
4. A synthetic message of form `<@bot-id> [Sentinel] Report readiness.` must produce `accepted` and **exactly one** durable interaction with expected world, context, NPC, author entity, thread, provider, message ID and status `received`.
5. Replay of the same event must produce `duplicate`, not another interaction. Reused source ID with altered content returns `event_conflict`; messages for wrong thread or lacking explicit alias are rejected.
6. Disable the synthetic policy again. Any new message must be `unauthorized`, with the already accepted interaction retained.
7. Throughout, verify **zero deliveries, zero local presence, zero response text/claim**, and the two operator policy audit records. The test does not instantiate a text generator, Discord client, or a delivery client.

## Run and evidence

The test is added to `src/db/discord-dev-fixture.db.test.ts` and runs with existing PostgreSQL integration CI using the synthetic test environment. Existing CI network guards remain active. Unit tests, full PostgreSQL regression and isolated Docker/Gateway DB smoke must stay green; no linter, formatter or migration checks may be bypassed.

Success is **offline interaction-persistence proof only**. It does not prove actual Discord message body access in live runtime, real user enrollment, end-to-end permissions or production operation. Enabling privileged `MessageContent` for a later live mention test, binding a real player, changing intake policy on a persistent scene, sending messages and configuring LLM are each separate security/design gates.

## Future live test preconditions (not part of this PR)

- Separate dedicated disposable test world/context or an explicitly defined reversible provisioning model that does not invalidate the Step 8 pristine fixture.
- Dedicated approved human test identity, validated guild/thread permissions and world-specific DM authority; no permanent player allowlist.
- A carefully designed short inbound-only smoke path with privately held bot credentials and explicit owner sign-off. Do not run normal `src/index.ts` as a shortcut.
- Database assertions for exactly one received interaction and zero outbound deliveries/LLM calls, a stop procedure and teardown.

Owner's local DB and Hetzner are intentionally left untouched by this PR.
