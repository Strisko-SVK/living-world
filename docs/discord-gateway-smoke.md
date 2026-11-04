# Step 9 — First inbound-only Discord Gateway smoke

Scope: **only transport visibility** in the isolated DEV thread. The bot must remain offline until all UI/security checks pass and the owner separately authorizes the login. This does not test NPC gameplay, write to the database, send/reply/edit messages, call an LLM, or deploy to Hetzner.

## Discord manual preflight

- Verify owner 2FA and exact DEV bot identity 1566909036899868712 in guild 1566911648701223053.
- Verify effective permissions: **View Channel** and thread access to private parent 1566913668795469934 and public test thread 1566914038158459090; no access to #dev-control or any other RP content.
- **Deny** Administrator, Send Messages, Send Messages in Threads, Create Threads, Manage Channels, Manage Roles, Manage Threads, and Manage Webhooks, including inherited grants. No outbound permissions.
- Keep context intake policy disabled; do not create Discord identity/user mappings.
- This smoke requests **Guilds and GuildMessages** Gateway intents only, no privileged **MessageContent** intent. It observes event metadata, never message contents. MessageContent access is a separate later decision.

## Local offline preflight

From your repository checkout with the already-created isolated DEV DB:

```bash
node --env-file=.env.gateway-dev.local --import tsx src/admin/gateway-dev-db.ts check
node --env-file=.env.gateway-dev.local --import tsx src/admin/discord-dev-fixture.ts
```

Require identity verified and fixture replay status **already_present** with the three previously recorded UUIDs. Otherwise STOP.

Create a separate local and Git-ignored file named **.env.gateway-smoke.local**, with file permissions 0600, containing only the two lines below. Do not share its content, tokens, screenshots, or shell history. Obtain the bot token locally from the Living World application in the [Discord Developer Portal](https://discord.com/developers/applications). If it is unavailable, follow the portal's current token flow; resetting rotates the token.

```dotenv
LW_DEV_BOT_USER_ID=1566909036899868712
DISCORD_TOKEN=<paste-token-only-in-your-private-local-file>
```

Keep the existing .env.gateway-dev.local values DISCORD_ENABLED=false, DISCORD_OUTBOUND_ENABLED=false, LLM_PROVIDER=disabled and the three route IDs unchanged. Do not add a token to .env.example or Git.

Run **offline config preflight** (no bot login, Discord request, DB write):

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-smoke.local --import tsx src/admin/discord-gateway-smoke.ts --preflight
```

Expected: {"event":"gateway_smoke_config_valid"}. Default invocation without arguments is also offline preflight.

## Live transport smoke — only after a separate explicit owner go-ahead

```bash
node --env-file=.env.gateway-dev.local --env-file=.env.gateway-smoke.local --import tsx src/admin/discord-gateway-smoke.ts --connect --confirm-guild 1566911648701223053 --inbound-only
```

Expect {"event":"gateway_smoke_ready"}. From your own Discord user account, send **one harmless message** in the isolated test thread. Do not mention players or include campaign/private data. Expect {"event":"gateway_smoke_target_message"} followed by {"event":"gateway_smoke_stopped"}. A 90-second timeout or any connection error fails safely and closes the client.

The standalone smoke code is intentionally separate from normal runtime, persistence, message sending, webhooks and LLM. It logs only fixed event names: no message text, author IDs, message IDs or secrets. It authenticates the expected bot and requires the configured DEV guild.

Afterwards repeat the offline fixture preview to verify **already_present** and unchanged world/context/NPC IDs. Unexpected bot output, DB mutation, cross-channel visibility, identity mismatch or write permission is an immediate STOP and investigation, not an automatic retry.

This first transport-only smoke does **not** establish gameplay/mention processing authorization or a live NPC response. Those require a later separately approved phase.
