# Security operations

Security hardening is not a claim that the live host is audited. Do not paste
credentials, full environment files, database exports or raw security reports
into GitHub, chat or Notion. AGENTS.md and product functionality are out of scope.

## New local database

Run `pnpm db:init`. This creates `.env` with a cryptographically random password,
owner-only permissions and loopback database URL. It refuses existing files and
symlinks. Then run `pnpm db:up` and the normal migration command. The Compose file
will refuse an absent or empty password and binds only `127.0.0.1:5432`.
The dedicated Gateway DEV database remains on `127.0.0.1:55432`.

## Existing database and host (requires operator verification)

A repository change does not alter a running container or rotate a password in
an existing PostgreSQL volume. Changing POSTGRES_PASSWORD in `.env` alone does
not rotate an initialized database password. Never run `down --volumes` as a
security fix. Preserve the database volume and make a private backup first.

Use `docker ps --format 'table {{.Names}}\t{{.Ports}}'` and `ss -lnt` to inspect
published/listening ports without printing environment secrets. Neither database
port should be published on `0.0.0.0` or `[::]`. The provider firewall should also
deny public inbound 5432 and 55432. UFW alone is not sufficient proof for Docker.
Do not close the SSH management path. Do not run `docker inspect` or unredacted
`docker compose config` into public logs.

If an existing database was reachable with a weak password, treat this as a
possible exposure: isolate networking, inspect private server logs, rotate the
role password through an authenticated local PostgreSQL session (interactive
`\password`, not a secret in shell history), update the private connection URL,
recreate only the affected service preserving its volume, then verify access.
A real leaked Discord/API token must be revoked at the provider before any Git
history rewrite. Do not force-push or rewrite history without a separate plan.

## Repository controls

Permanent workflows use explicit least privilege, immutable action commit SHAs,
no persisted checkout credentials and no privileged pull-request/comment trigger.
Security CI scans reachable branches/tags/PR heads, the current tree and commit
messages using a checksum-verified Gitleaks binary. Raw reports are temporary and
never uploaded. Failures, including scanner/registry outages, fail closed.
Known test fixtures must be individually investigated; no blanket test/history
allowlist or baseline is permitted. No secret found is not proof of absence.
Dependency audit includes development dependencies. Dependabot proposes weekly
npm and action updates; it does not auto-merge. GitHub CodeQL default setup
publishes code-scanning alerts. The separate CI CodeQL job performs local
security-extended JavaScript/TypeScript analysis with `upload: never`, reads
its local SARIF and fails on findings or missing analysis. No application starts.

A narrow dependency override upgrades the legacy esbuild dependency of
`@esbuild-kit/core-utils@3.3.2` to the already-used `0.25.12`. This removes the
version affected by GHSA-67mh-4wv8-2f99. Frozen installation, quality gate and real
migration/integration tests must pass before this is accepted.

GitHub administrative settings are separate from tracked files. Configure and
read back: main requires PRs and all named CI/security checks, administrators are
included, force-push/deletion disabled, default Actions token read-only, workflow
PR approvals disabled, approval required for all external contributors, secret
scanning and push protection enabled, Dependabot alerts/security updates enabled.
The sole-maintainer setup uses zero mandatory third-party approvals, not an
impossible self-review requirement. Review installed apps, deploy keys,
collaborators and account 2FA locally. No token should be sent to an assistant.

This does not change the repository visibility, deploy anything, log into Discord,
send a message, or call a paid LLM service.
