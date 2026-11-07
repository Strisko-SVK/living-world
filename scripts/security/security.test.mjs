import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initialiseLocalEnvironment } from "./init-local-env.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "lw-security-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const example = join(dir, "example");
  await writeFile(example, "DATABASE_URL=\nPOSTGRES_PASSWORD=\nDISCORD_ENABLED=false\n");
  return { dir, example, target: join(dir, ".env") };
}

test("creates matching random credentials without enabling runtime", async (t) => {
  const { example, target } = await fixture(t);
  await initialiseLocalEnvironment(example, target);
  const text = await readFile(target, "utf8");
  const password = text.match(/^POSTGRES_PASSWORD=([a-f0-9]{64})$/m)?.[1];
  assert.ok(password);
  assert.ok(text.includes(`postgresql://living_world:${password}@127.0.0.1:5432/living_world`));
  assert.ok(text.includes("DISCORD_ENABLED=false"));
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});
test("refuses to overwrite existing credentials", async (t) => {
  const { example, target } = await fixture(t);
  await writeFile(target, "keep-existing");
  await assert.rejects(initialiseLocalEnvironment(example, target));
  assert.equal(await readFile(target, "utf8"), "keep-existing");
});
test("refuses symbolic link targets", async (t) => {
  const { dir, example, target } = await fixture(t);
  const existing = join(dir, "existing");
  await writeFile(existing, "unchanged");
  await symlink(existing, target);
  await assert.rejects(initialiseLocalEnvironment(example, target));
  assert.equal(await readFile(existing, "utf8"), "unchanged");
});
test("rejects an unexpected credential template", async (t) => {
  const { example, target } = await fixture(t);
  await writeFile(example, "DATABASE_URL=unexpected\nPOSTGRES_PASSWORD=unexpected\n");
  await assert.rejects(initialiseLocalEnvironment(example, target));
  await assert.rejects(stat(target));
});
test("uses different credentials for independent environments", async (t) => {
  const { example, target, dir } = await fixture(t);
  await initialiseLocalEnvironment(example, target);
  const second = join(dir, ".env.second");
  await initialiseLocalEnvironment(example, second);
  assert.notEqual(await readFile(target, "utf8"), await readFile(second, "utf8"));
});
test("both Compose databases are loopback-only and require passwords", async () => {
  const normal = await readFile("docker-compose.yml", "utf8");
  const isolated = await readFile("compose.gateway-dev.yml", "utf8");
  assert.ok(normal.includes('"127.0.0.1:5432:5432"'));
  assert.ok(normal.includes("${POSTGRES_PASSWORD:?"));
  assert.ok(!normal.includes("POSTGRES_PASSWORD:-"));
  assert.ok(isolated.includes('"127.0.0.1:55432:5432"'));
  assert.ok(isolated.includes("${LW_GATEWAY_DEV_ADMIN_PASSWORD:?"));
});
test("permanent workflows pin actions and never use privileged PR triggers", async () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/security.yml"]) {
    const text = await readFile(path, "utf8");
    assert.match(text, /permissions:\n  contents: read/);
    assert.ok(!text.includes("pull_request_target:"));
    assert.ok(!text.includes("issue_comment:"));
    const uses = [...text.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    assert.ok(uses.length > 0);
    for (const action of uses) assert.match(action, /@[a-f0-9]{40}$/);
    const checkouts = uses.filter((action) => action.startsWith("actions/checkout@"));
    assert.equal((text.match(/persist-credentials: false/g) ?? []).length, checkouts.length);
  }
});
