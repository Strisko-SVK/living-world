# Repository-owner security checklist

Tracked files cannot enable GitHub administrative settings or change a running
server. The GitHub connector used for the security work has no Administration
access. Complete these controls from the owner's GitHub account; never send a
personal token, bot token, password or recovery code to an assistant.

## Main branch protection

Repository Settings > Branches > Add classic branch protection rule, pattern
`main`. A ruleset with equivalent settings is also suitable; use an existing rule
rather than introducing conflicting rules.

- Require a pull request before merging.
- Do not require an approving reviewer while this is a sole-maintainer project.
  Keep the PR requirement; disabling mandatory third-party approval must not
  disable required checks.
- Require status checks before merging and require the branch to be up to date.
- Select these checks, using GitHub Actions as their expected source where the
  interface offers the option: `Quality Gate`, `PostgreSQL 17 Integration`,
  `Isolated Gateway DEV PostgreSQL`, `Secret Scan`, `Dependency Audit`, `CodeQL`.
- Require conversation resolution before merging.
- Enable "Do not allow bypassing the above settings" so administrators are also
  covered. Do not add bypass actors.
- Leave force pushes and branch deletion disabled.

Save, reload and verify the rule is active. A passing workflow alone does not
prove these rules are enabled. Do not test protection by force-pushing or deleting
`main`.

## Repository security features

In Settings > Security, use the available Code security / Advanced Security
settings pages (labels can differ between GitHub versions).

- Enable dependency graph, Dependabot alerts and Dependabot security updates.
- Enable secret scanning and repository push protection, including generic secret
  patterns when available. Review any existing alerts; do not dismiss them merely
  to make a dashboard green.
- GitHub CodeQL default setup publishes alerts. Our separate CodeQL job runs
  security-extended queries as a local CI gate with `upload: never`, to avoid
  conflicts and duplicate uploads. Keep both safeguards enabled.
- Public repository security features do not require purchasing an additional
  product for this project. Do not enable paid extras as part of this checklist.

The checked-in Dependabot file schedules update PRs. It does not itself prove
Dependabot alerts, security updates or push protection are enabled.

## Actions and account access

Settings > Actions > General:

- Set workflow permissions to read repository contents and packages.
- Disable "Allow GitHub Actions to create and approve pull requests".
- Require approval for workflows from all outside contributors, not only new
  GitHub users. Review the changed workflow/code before approving a run.
- Do not use a self-hosted runner for untrusted public pull requests.

Review repository Settings for Collaborators, Deploy keys and Webhooks, and
account Settings > Applications. Remove only entries confirmed unnecessary; do
not disconnect legitimate project integrations blindly. Use account two-factor
authentication or a passkey and keep recovery codes private.

## Live host verification (separate from GitHub)

Run only these read-only commands first on the actual project host:

```sh
docker ps --format 'table {{.Names}}\t{{.Ports}}'
ss -lnt
```

The database ports 5432 and 55432 should not be published on `0.0.0.0` or `[::]`.
Check provider firewall rules too. Do not print `.env`, full `docker inspect`,
unredacted `docker compose config`, process environments or shell history.

A change to Compose does not reconfigure an already-running container. A new
POSTGRES_PASSWORD environment variable does not rotate an initialized PostgreSQL
volume's password. Follow [security operations](security-operations.md), preserve
volumes, and schedule any needed container recreation/password rotation with the
operator. Do not run `down --volumes`.

## Evidence from the 7 November 2026 exposure audit

Read-only run `42378245979` scanned 345 reachable Git commits, current files and
commit messages. It also scanned 27 issue/PR records, 19 reviews, 5 issue comments,
6 inline review comments, 281 completed CI-run log archives containing 1,570 log
files, and one retained artifact. All four Gitleaks scopes reported zero findings.
Two listed runs were still active and were not part of the log archive scan.

This is a point-in-time scanner result, not proof that no secret ever existed.
Deleted/unreachable Git objects, removed comments, unavailable historical content,
the live server and account-level integrations are outside that result. No raw
secret report or collected discussion/log archive was published.

Dependency remediation includes patched Zod and Vitest, an explicit patched Vite
peer, and narrowly version-scoped overrides for legacy esbuild, source-map-js and
minimatch. The complete frozen install, type/lint/build/unit/security/real-database
test gates must pass before acceptance. Audit includes development dependencies
and does not suppress advisory severity levels.
