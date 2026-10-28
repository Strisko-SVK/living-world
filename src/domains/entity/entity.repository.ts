import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../../db/client.js";
import { entityAliases } from "../../db/schema/entity-aliases.js";
import { entities } from "../../db/schema/entities.js";

import { normalizeAlias } from "./alias-normalizer.js";
import {
  addEntityAliasInputSchema,
  createEntityInputSchema,
  type AddEntityAliasInput,
  type CreateEntityInput,
} from "./entity.validation.js";

type Database = Omit<DatabaseClient["db"], "$client">;

export async function createEntity(
  database: Database,
  worldId: string,
  input: CreateEntityInput,
) {
  const value = createEntityInputSchema.parse(input);
  const [entity] = await database
    .insert(entities)
    .values({ id: randomUUID(), worldId, ...value })
    .returning();

  if (!entity) {
    throw new Error("Entity creation did not return a record.");
  }

  return entity;
}

export async function getEntity(
  database: Database,
  worldId: string,
  entityId: string,
) {
  const [entity] = await database
    .select()
    .from(entities)
    .where(and(eq(entities.id, entityId), eq(entities.worldId, worldId)))
    .limit(1);

  return entity ?? null;
}

export async function findEntityByCanonicalName(
  database: Database,
  worldId: string,
  canonicalName: string,
) {
  const [entity] = await database
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.worldId, worldId),
        eq(entities.canonicalName, canonicalName),
      ),
    )
    .limit(1);

  return entity ?? null;
}

export async function addEntityAlias(
  database: Database,
  worldId: string,
  entityId: string,
  input: AddEntityAliasInput,
) {
  const value = addEntityAliasInputSchema.parse(input);
  return database.transaction(async (transaction) => {
    await lockEntityAlias(transaction, worldId, value.alias);
    const entity = await getEntity(transaction, worldId, entityId);
    if (!entity)
      throw new Error("Entity was not found in the specified world.");
    const [entityAlias] = await transaction
      .insert(entityAliases)
      .values({
        id: randomUUID(),
        entityId: entity.id,
        alias: value.alias,
        normalizedAlias: normalizeAlias(value.alias),
      })
      .returning();
    if (!entityAlias)
      throw new Error("Entity alias creation did not return a record.");
    return entityAlias;
  });
}

// Registration and intake share this key even when no alias row exists yet.
export async function lockEntityAlias(
  database: Database,
  worldId: string,
  alias: string,
) {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["alias", worldId, normalizeAlias(alias)])},0))`,
  );
}

export async function findEntitiesByAlias(
  database: Database,
  worldId: string,
  alias: string,
  lock = false,
) {
  const query = database
    .select({ entity: entities })
    .from(entityAliases)
    .innerJoin(entities, eq(entityAliases.entityId, entities.id))
    .where(
      and(
        eq(entities.worldId, worldId),
        eq(entityAliases.normalizedAlias, normalizeAlias(alias)),
      ),
    );

  const rows = await (lock ? query.for("share") : query);
  return rows.map((row) => row.entity);
}
