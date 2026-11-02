import { createHash } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { discordOutboundLimits } from "../../db/schema/discord-outbound-limits.js";
export interface OutboundLimits {
  check(
    webhookId: string,
    version: string,
  ): Promise<{ allowed: boolean; reason?: string; retryAfterMs: number }>;
  defer(webhookId: string, ms: number, global: boolean): Promise<void>;
  disable(webhookId: string, version: string): Promise<void>;
}
export const limitKeys = (id: string, version: string) => ({
  global: "discord:global",
  webhook: "discord:webhook:" + createHash("sha256").update(id).digest("hex"),
  credential:
    "discord:credential:" +
    createHash("sha256")
      .update(id + ":" + version)
      .digest("hex"),
});
export function createOutboundLimits(
  database: Omit<DatabaseClient["db"], "$client">,
  clock: () => Date = () => new Date(),
): OutboundLimits {
  async function bounded<T>(
    work: (tx: Omit<DatabaseClient["db"], "$client">) => Promise<T>,
  ) {
    return database.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout='2s'`);
      await tx.execute(sql`set local statement_timeout='5s'`);
      return work(tx);
    });
  }
  async function store(
    rows: { key: string; notBefore: Date; disabled: boolean }[],
  ) {
    await bounded(async (tx) => {
      await tx
        .insert(discordOutboundLimits)
        .values(rows)
        .onConflictDoUpdate({
          target: discordOutboundLimits.key,
          set: {
            notBefore: sql`greatest(${discordOutboundLimits.notBefore},excluded.not_before)`,
            disabled: sql`${discordOutboundLimits.disabled} or excluded.disabled`,
          },
        });
    });
  }
  return {
    async check(id, version) {
      const keys = limitKeys(id, version);
      const rows = await bounded((tx) =>
        tx
          .select()
          .from(discordOutboundLimits)
          .where(inArray(discordOutboundLimits.key, Object.values(keys))),
      );
      if (rows.some((r) => r.disabled))
        return {
          allowed: false,
          reason: "credential_disabled",
          retryAfterMs: 0,
        };
      const delay = Math.max(
        0,
        ...rows.map((r) => r.notBefore.getTime() - clock().getTime()),
      );
      return {
        allowed: delay === 0,
        reason: delay ? "rate_limited" : undefined,
        retryAfterMs: delay,
      };
    },
    async defer(id, ms, global) {
      if (!Number.isFinite(ms) || ms < 0 || ms > 86_400_000)
        throw Error("Invalid outbound cooldown.");
      const keys = limitKeys(id, "");
      const until = new Date(clock().getTime() + ms);
      await store(
        [keys.webhook, ...(global ? [keys.global] : [])].map((key) => ({
          key,
          notBefore: until,
          disabled: false,
        })),
      );
    },
    async disable(id, version) {
      await store([
        {
          key: limitKeys(id, version).credential,
          notBefore: new Date(0),
          disabled: true,
        },
      ]);
    },
  };
}
