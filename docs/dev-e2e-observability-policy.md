# 🔴 P0 — Mandatory structured diagnostics for DEV / E2E testing

> **Owner requirement, 6 November 2026.** Every Living World DEV, local
> integration, Gateway pilot, NPC E2E and CI test must provide actionable,
> privacy-safe diagnostic logging by default. **`failed_safely` alone is
> not sufficient.** This requirement is a review/Definition-of-Done gate,
> not an optional post-failure enhancement.
>
> Canonical project decision: Notion document 11, **§93**, red critical
> observability requirement.

## Minimum lifecycle diagnostic contract

For each test session, emit fixed-schema JSON with a bounded session trace ID,
timestamp, stage, outcome and safe reason code. At minimum track:

1. Local preflight and environment/DB identity gates.
2. Discord Gateway connect, intended guild/thread event seen, and disconnect.
3. Normalization validity, trigger, mention, exact scene, participant and policy.
4. Intake persistence accepted/rejected, deduplication, and post-write audit.
5. Future NPC response generation, outbound delivery and acknowledgment **only
   once separately owner-approved**.
6. Terminal result, timeout and cleanup. Unknown errors are classified as
   `unexpected_error` without emitting exception detail or user content.

A rejected event must log a specific classification (`content_unavailable`,
`source_message_id_invalid`, `sender_or_kind_rejected`,
`timeout_without_match`, etc.), sufficient to reproduce the issue in
an offline test. Add automated assertions that redacted logging itself works.
Do not replace detailed classification with a single catch-all status.

## Safety guardrails

- Scope-filter Discord messages **before** logging anything about an event;
  unrelated guilds/channels must not leave a trace.
- Never include bot tokens, secrets, user/message/guild/thread snowflakes,
  database connection strings, raw payloads, message text, prompts, roleplay
  narrative, personal identifiers, raw SQL or SDK exception details.
- Log only fixed allowlisted stage names, bounded counts, safe booleans and
  synthetic trace IDs. No raw environment dump or debug proxy of whole events.
- Diagnostics must not relax fail-closed authorization, trigger policy, the
  one-event latch, isolation, read-only gates or outbound/LLM kill switches.
- Controlled DEV logging is **always on** during tests. Production verbosity
  should be deliberately bounded and privacy-preserving. Define retention and
  rotation before writing persistent server-side debug archives.
- An online bot, a successful Gateway login, and an accepted DB interaction are
  three distinct milestones. Every terminal result must distinguish them.

## Immediate first-contact incident (M2.14E)

The second owner-approved live one-shot session returned:

```text
pilot_gateway_ready
target_thread_event_seen
message_normalization_rejected
timeout_without_match
pilot_gateway_stopped
npc_e2e_inbound_failed_safely
```

This proves an event from the exact target thread reached the SDK, then failed
the common adapter's `normalizeDiscordMessage` before reaching intake. The
timeout is the downstream effect, not the underlying root cause. The original
code could reject empty/unavailable content or a malformed SDK/schema field
without saying which. The M2.14E draft introduces **reason-only normalizer
diagnostics** and offline tests for these paths, without logging any raw data.

Discord's official Gateway documentation says content can be empty without
privileged `MESSAGE_CONTENT`, but specifically exempts messages which
directly mention the app. Therefore **do not assume an intent or permission
fix without confirming the new reason code**. Inbound-only, no outbound sends.

## Completion checklist for each future milestone

- [ ] Normal, rejection, timeout, upstream failure and cleanup paths all emit
      testable sanitized stages.
- [ ] Offline negative tests assert the stage/reason and that no private
      contents appear in logs.
- [ ] Owner-readable runbook explains the diagnostic interpretation and safe
      next step.
- [ ] Real Discord connection, DB changes, sends and paid LLM calls still
      require their separate explicit approval.
- [ ] Do not schedule repeat live tests solely to obtain details that could
      have been observed in the first attempt.

**Implementation status:** This policy is recorded now. M2.14E adds the
first fine-grained shared normalizer diagnostic. Full cross-project coverage
and any persistent log storage/rotation must be tracked as follow-up work;
do not mark it complete merely because this file exists.
