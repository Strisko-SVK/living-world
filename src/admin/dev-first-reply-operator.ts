import { createHmac } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";

import { firstReplyWorldKey } from "./dev-first-reply-provision.js";

// Separate from the PostgreSQL role, Discord token and synthetic entity ID:
// proof of possession of a private 0600 local OS-owned operator key, bound to
// ONE received Discord snowflake and the exact first-reply route.
const approved = new WeakSet<object>();
const sourceSchema = z.string().regex(/^[1-9][0-9]{16,19}$/u);
export type LocalOperatorApproval = Readonly<{
  sourceMessageId: string;
  proof: string;
}>;
export function isLocalOperatorApproved(value: object): boolean {
  return approved.has(value);
}
export async function authenticateLocalFirstReplyOperator(
  env: NodeJS.ProcessEnv,
  sourceMessageId: string,
): Promise<LocalOperatorApproval | null> {
  if (!sourceSchema.safeParse(sourceMessageId).success) return null;
  const keyPath = env.LW_FIRST_REPLY_OPERATOR_KEY_PATH ?? "";
  const uid = process.getuid?.();
  const expectedUid = env.LW_FIRST_REPLY_OPERATOR_UID;
  const fromRepo = relative(process.cwd(), keyPath);
  if (
    !isAbsolute(keyPath) ||
    uid === undefined ||
    String(uid) !== expectedUid ||
    fromRepo === "" ||
    (fromRepo !== ".." &&
      !fromRepo.startsWith(".." + sep) &&
      !isAbsolute(fromRepo))
  )
    return null;

  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await fh.stat();
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size < 64 ||
      stat.size > 66
    )
      return null;
    const key = (await fh.readFile({ encoding: "utf8" })).trim();
    if (!/^[a-f0-9]{64}$/u.test(key)) return null;
    const route = [
      firstReplyWorldKey,
      env.LW_FIRST_REPLY_GUILD_ID,
      env.LW_FIRST_REPLY_PARENT_ID,
      env.LW_FIRST_REPLY_THREAD_ID,
      sourceMessageId,
    ].join(":");
    const proof = createHmac("sha256", Buffer.from(key, "hex"))
      .update(route)
      .digest("hex");
    const capability = Object.freeze({ sourceMessageId, proof });
    approved.add(capability);
    return capability;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
