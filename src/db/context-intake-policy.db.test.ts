import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "./client.js";

const database = createDatabaseClient();
afterAll(async () => database.close());

describe("0012 context intake policy migration", () => {
  it("disables preexisting and new contexts and rejects invalid policy values", async () => {
    const client = await database.pool.connect();
    const schema = `policy_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`create schema "${schema}"`);
      await client.query(`set local search_path to "${schema}"`);
      // Minimal pre-0012 shape required by the real forward migration.
      await client.query(
        "create table interaction_contexts(id uuid primary key, world_id uuid not null, unique(world_id,id))",
      );
      await client.query(
        "insert into interaction_contexts(id,world_id) values($1,$2)",
        [randomUUID(), randomUUID()],
      );
      const migration = readFileSync(
        new URL("./migrations/0012_context_intake_policy.sql", import.meta.url),
        "utf8",
      ).replaceAll('"public".', `"${schema}".`);
      for (const statement of migration.split("--> statement-breakpoint"))
        await client.query(statement);
      await client.query(
        "insert into interaction_contexts(id,world_id) values($1,$2)",
        [randomUUID(), randomUUID()],
      );
      expect(
        (
          await client.query(
            "select npc_intake_policy from interaction_contexts",
          )
        ).rows,
      ).toEqual([
        { npc_intake_policy: "disabled" },
        { npc_intake_policy: "disabled" },
      ]);
      await expect(
        client.query(
          "update interaction_contexts set npc_intake_policy='everyone'",
        ),
      ).rejects.toMatchObject({ code: "22P02" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
