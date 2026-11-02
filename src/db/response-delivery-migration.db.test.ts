import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { createDatabaseClient } from "./client.js";
const database = createDatabaseClient();
afterAll(async () => database.close());
it("0015 preserves historical responses without inventing source routes or enqueuing delivery", async () => {
  const client = await database.pool.connect(),
    schema = "delivery_" + randomUUID().replaceAll("-", "");
  const ids = Array.from({ length: 4 }, () => randomUUID());
  try {
    await client.query("BEGIN");
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    await client.query(
      "create table interactions(id uuid primary key,world_id uuid not null,npc_id uuid not null,context_id uuid not null,source_provider text,response_text text,response_message_id text,status text)",
    );
    await client.query(
      "insert into interactions(id,world_id,npc_id,context_id,source_provider,response_text,response_message_id,status) values($1,$2,$3,$4,'discord','Existing speech','legacy-reference','responded')",
      ids,
    );
    const {
      rows: [before],
    } = await client.query("select * from interactions");
    const migration = readFileSync(
      new URL(
        "./migrations/0015_response_delivery_outbox.sql",
        import.meta.url,
      ),
      "utf8",
    ).replaceAll('"public".', `"${schema}".`);
    for (const statement of migration.split("--> statement-breakpoint"))
      await client.query(statement);
    const {
      rows: [after],
    } = await client.query("select * from interactions");
    expect(after).toEqual({
      ...before,
      source_guild_id: null,
      source_channel_id: null,
      source_thread_id: null,
      source_mapping_id: null,
    });
    expect(
      (await client.query("select count(*) from npc_response_deliveries"))
        .rows[0].count,
    ).toBe("0");
    await expect(
      client.query(
        "update interactions set source_guild_id='invented',source_channel_id='invented',source_mapping_id=$1 where id=$2",
        [randomUUID(), ids[0]],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
