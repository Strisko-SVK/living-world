import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateLocalFirstReplyOperator,
  isLocalOperatorApproved,
} from "./dev-first-reply-operator.js";

const sourceId = "1888888888888888999";
let folder: string | undefined;
const config = (path: string): NodeJS.ProcessEnv => ({
  LW_FIRST_REPLY_OPERATOR_KEY_PATH: path,
  LW_FIRST_REPLY_OPERATOR_UID: String(process.getuid?.()),
  LW_FIRST_REPLY_GUILD_ID: "1777777777777777701",
  LW_FIRST_REPLY_PARENT_ID: "1777777777777777702",
  LW_FIRST_REPLY_THREAD_ID: "1777777777777777703",
});
async function keyFile(mode: number) {
  folder = await mkdtemp(join(tmpdir(), "lw-operator-unit-"));
  const file = join(folder, "approval.key");
  await writeFile(file, randomBytes(32).toString("hex") + "\n", { mode });
  await chmod(file, mode);
  return file;
}
afterEach(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = undefined;
});

describe("M2.15O independent first-reply local operator authentication", () => {
  it("authenticates only an exact OS-owned 0600 secret outside Git", async () => {
    const file = await keyFile(0o600);
    const approved = await authenticateLocalFirstReplyOperator(
      config(file),
      sourceId,
    );
    expect(approved).not.toBeNull();
    expect(isLocalOperatorApproved(approved!)).toBe(true);
    expect(approved?.sourceMessageId).toBe(sourceId);
    expect(approved?.proof).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(approved)).not.toContain("approval.key");
  });

  it("binds proof to the original source and the exact route", async () => {
    const file = await keyFile(0o600);
    const first = await authenticateLocalFirstReplyOperator(
      config(file),
      sourceId,
    );
    const second = await authenticateLocalFirstReplyOperator(
      config(file),
      "1888888888888888998",
    );
    const different = await authenticateLocalFirstReplyOperator(
      { ...config(file), LW_FIRST_REPLY_THREAD_ID: "1777777777777777799" },
      sourceId,
    );
    expect(first?.proof).not.toBe(second?.proof);
    expect(first?.proof).not.toBe(different?.proof);
    expect(
      isLocalOperatorApproved({
        sourceMessageId: sourceId,
        proof: first!.proof,
      }),
    ).toBe(false);
  });

  it("rejects a permissive file, wrong owner UID, and malformed source", async () => {
    const file = await keyFile(0o644);
    expect(
      await authenticateLocalFirstReplyOperator(config(file), sourceId),
    ).toBeNull();
    await chmod(file, 0o600);
    expect(
      await authenticateLocalFirstReplyOperator(
        { ...config(file), LW_FIRST_REPLY_OPERATOR_UID: "999999" },
        sourceId,
      ),
    ).toBeNull();
    expect(
      await authenticateLocalFirstReplyOperator(config(file), "bad"),
    ).toBeNull();
  });

  it("rejects symlinks even when pointing to a valid file", async () => {
    const file = await keyFile(0o600);
    const link = join(folder!, "link.key");
    await symlink(file, link);
    expect(
      await authenticateLocalFirstReplyOperator(config(link), sourceId),
    ).toBeNull();
  });
});
