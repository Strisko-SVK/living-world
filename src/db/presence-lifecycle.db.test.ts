import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "./client.js";

const database = createDatabaseClient();
afterAll(async () => database.close());
describe("0014 presence lifecycle upgrade", () => {
  it("revokes preexisting grants without rewriting their identity or prior revocations", async () => {
    const client = await database.pool.connect();
    const schema = `presence_${randomUUID().replaceAll("-", "")}`;
    const [world, npc, context, oldGrant, revokedGrant] = Array.from(
      { length: 5 },
      () => randomUUID(),
    );
    try {
      await client.query("BEGIN");
      await client.query(`create schema "${schema}"`);
      await client.query(`set local search_path to "${schema}"`);
      await client.query(
        "create table worlds(id uuid primary key,status text); create table entities(id uuid primary key,world_id uuid,status text); create table npcs(entity_id uuid primary key,lifecycle_state text); create table interaction_contexts(id uuid primary key,world_id uuid,status text); create table local_presence(id uuid primary key,world_id uuid,npc_id uuid,context_id uuid,issued_at timestamptz default now(),revoked_at timestamptz,revoked_by text)",
      );
      await client.query(
        "insert into local_presence(id,world_id,npc_id,context_id) values($1,$2,$3,$4)",
        [oldGrant, world, npc, context],
      );
      await client.query(
        "insert into local_presence(id,world_id,npc_id,context_id,revoked_at,revoked_by) values($1,$2,$3,$4,'2026-01-01Z','prior_role')",
        [revokedGrant, world, npc, context],
      );
      const { rows: before } = await client.query(
        "select * from local_presence order by id",
      );
      const migration = readFileSync(
        new URL("./migrations/0014_presence_lifecycle.sql", import.meta.url),
        "utf8",
      )
        .replaceAll('"public".', `"${schema}".`)
        .replaceAll("public.", `"${schema}".`);
      for (const statement of migration.split("--> statement-breakpoint"))
        await client.query(statement);
      const { rows: after } = await client.query(
        "select * from local_presence order by id",
      );
      for (let i = 0; i < before.length; i++) {
        const { revoked_at, revoked_by, ...identity } = after[i];
        const {
          revoked_at: previousTime,
          revoked_by: previousRole,
          ...previousIdentity
        } = before[i];
        void previousTime;
        void previousRole;
        expect(identity).toEqual(previousIdentity);
        if (before[i].id === oldGrant) {
          expect(revoked_at).toBeInstanceOf(Date);
          expect(revoked_by).toBe(
            (await client.query("select current_user as role")).rows[0].role,
          );
        } else expect(after[i]).toEqual(before[i]);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
