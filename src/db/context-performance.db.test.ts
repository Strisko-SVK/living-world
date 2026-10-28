import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { getDatabaseConfig } from "./config.js";
import { createContextBuilder } from "../context/context-builder.js";
import { createContextReader } from "../context/context.repository.js";
import { createWorld } from "../domains/world/world.repository.js";
import { createNpc } from "../domains/npc/npc.repository.js";
import { peloNpcFixture } from "../domains/npc/npc.test-fixture.js";
import {
  createInteractionContext,
  createInteraction,
} from "../domains/interaction/interaction.repository.js";
import { sql } from "drizzle-orm";

it("measures bounded context retrieval against reproducible synthetic data", async () => {
  const pool = new Pool({ connectionString: getDatabaseConfig().databaseUrl });
  const queries: string[] = [];
  const db = drizzle({
    client: pool,
    logger: {
      logQuery(query) {
        queries.push(query);
      },
    },
  });
  const rollback = new Error("fixture rollback");
  try {
    await db.transaction(async (tx) => {
      const world = await createWorld(tx, {
        key: "context-perf-" + randomUUID(),
        name: "Synthetic benchmark",
        systemType: "test",
      });
      const npc = await createNpc(tx, world.id, peloNpcFixture);
      const scene = await createInteractionContext(tx, world.id, {
        contextType: "scene",
      });
      const interaction = (await createInteraction(tx, world.id, npc.entityId, {
        contextId: scene.id,
        interactionType: "social",
        communicationMode: "unknown",
        requestText: "docking manifest",
      }))!;
      // 200 claims, 100 memories, 3 sources each. Only 10 claims and 5 memories
      // match the request; unrelated records have neither terms nor participants.
      await tx.execute(sql`insert into npc_knowledge(id,world_id,npc_id,claim_text,classification,confidence,secrecy)
        select gen_random_uuid(),${world.id},${npc.entityId},case when n<=10 then 'docking manifest '||n else 'unrelated astronomy '||n end,'reported_claim',0.5,'private' from generate_series(1,200) n`);
      await tx.execute(
        sql`insert into knowledge_sources(id,knowledge_id,source_type) select gen_random_uuid(),k.id,'heard' from npc_knowledge k cross join generate_series(1,3) where k.world_id=${world.id}`,
      );
      await tx.execute(sql`insert into npc_memories(id,world_id,npc_id,memory_type,summary,importance,detail_level,retention_class)
        select gen_random_uuid(),${world.id},${npc.entityId},'episodic',case when n<=5 then 'docking manifest '||n else 'unrelated astronomy '||n end,50,'high','normal' from generate_series(1,100) n`);
      await tx.execute(
        sql`insert into memory_sources(id,memory_id,source_type) select gen_random_uuid(),m.id,'heard' from npc_memories m cross join generate_series(1,3) where m.world_id=${world.id}`,
      );
      const measurements: Array<{ queries: number; ms: number }> = [];
      for (let run = 0; run < 3; run++) {
        queries.length = 0;
        const started = performance.now();
        const bundle = await createContextBuilder(createContextReader(tx))({
          worldId: world.id,
          npcId: npc.entityId,
          interactionId: interaction.id,
        });
        measurements.push({
          queries: queries.length,
          ms: Math.round((performance.now() - started) * 100) / 100,
        });
        expect(bundle.knowledge).toHaveLength(10);
        expect(bundle.memories).toHaveLength(5);
      }
      console.info("context benchmark", JSON.stringify(measurements));
      expect(measurements.map((row) => row.queries)).toEqual([16, 16, 16]);
      // Grow only unrelated data tenfold: retrieval and round trips must stay
      // bounded. Timing is reported for review, never used as a CI threshold.
      await tx.execute(sql`insert into npc_knowledge(id,world_id,npc_id,claim_text,classification,confidence,secrecy)
        select gen_random_uuid(),${world.id},${npc.entityId},'unrelated astronomy','rumor',0.5,'private' from generate_series(1,1800)`);
      await tx.execute(sql`insert into npc_memories(id,world_id,npc_id,memory_type,summary,importance,detail_level,retention_class)
        select gen_random_uuid(),${world.id},${npc.entityId},'episodic','unrelated astronomy',50,'high','normal' from generate_series(1,900)`);
      queries.length = 0;
      const reader = createContextReader(tx);
      const grown = await createContextBuilder(reader)({
        worldId: world.id,
        npcId: npc.entityId,
        interactionId: interaction.id,
      });
      expect(queries).toHaveLength(16);
      expect(grown.retrieval.categories.knowledge.retrieved).toBe(10);
      expect(grown.retrieval.categories.memories.retrieved).toBe(5);
      expect(
        queries.filter((query) => query.includes('"ranked_sources"')),
      ).toHaveLength(2);
      expect([...reader.sourceTotals!.values()]).toHaveLength(15);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await pool.end();
  }
}, 30000);
