import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../../db/client.js";
import { worlds } from "../../db/schema/worlds.js";

import {
  createWorldInputSchema,
  type CreateWorldInput,
} from "./world.validation.js";

type Database = DatabaseClient["db"];

export async function createWorld(database: Database, input: CreateWorldInput) {
  const value = createWorldInputSchema.parse(input);
  const [world] = await database
    .insert(worlds)
    .values({ id: randomUUID(), ...value })
    .returning();

  if (!world) {
    throw new Error("World creation did not return a record.");
  }

  return world;
}

export async function getWorldById(database: Database, worldId: string) {
  const [world] = await database
    .select()
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);

  return world ?? null;
}

export async function getWorldByKey(database: Database, key: string) {
  const [world] = await database
    .select()
    .from(worlds)
    .where(eq(worlds.key, key))
    .limit(1);

  return world ?? null;
}
