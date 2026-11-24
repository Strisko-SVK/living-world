import { readFileSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import { discordNpcRegistry } from "../db/schema/index.js";
import { normalizeAlias } from "../domains/entity/alias-normalizer.js";
import {
  addEntityAlias,
  createEntity,
  findEntitiesByAlias,
  findEntityByCanonicalName,
  getEntity,
  lockEntityAlias,
} from "../domains/entity/entity.repository.js";
import { createNpc, getNpc } from "../domains/npc/npc.repository.js";
import { createNpcInputSchema } from "../domains/npc/npc.validation.js";

type Database = Omit<DatabaseClient["db"], "$client">;
const name = z.string().trim().min(1).max(80);
const npcInput = createNpcInputSchema
  .pick({
    canonicalName: true,
    simulationDepth: true,
    narrativeWeight: true,
    templateVersion: true,
    profileVersion: true,
    baselineProfile: true,
  })
  .strict();

const templateSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    home: z.string().trim().min(1).max(200),
    aliases: z.array(name).min(1).max(12),
    npc: npcInput,
  })
  .strict()
  .superRefine((template, context) => {
    if (template.npc.canonicalName !== template.npc.baselineProfile.identity.name)
      context.addIssue({
        code: "custom",
        path: ["npc", "baselineProfile", "identity", "name"],
        message: "Identity must match canonical name.",
      });
    if (template.npc.canonicalName.length > 80)
      context.addIssue({
        code: "custom",
        path: ["npc", "canonicalName"],
        message: "Discord canonical name must be at most 80 characters.",
      });
    const aliases = template.aliases.map(normalizeAlias);
    if (new Set(aliases).size !== aliases.length)
      context.addIssue({
        code: "custom",
        path: ["aliases"],
        message: "Duplicate normalized aliases.",
      });
  });

export const npcCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    templates: z.array(templateSchema).max(25),
  })
  .strict()
  .superRefine((catalog, context) => {
    const keys = new Set(["quartermaster", "sentinel"]);
    const aliases = new Set([
      "quartermaster",
      "marcus voss",
      "voss",
      "sentinel",
      "sentinel-001",
    ]);
    for (const [index, template] of catalog.templates.entries()) {
      const names = new Set([
        normalizeAlias(template.npc.canonicalName),
        ...template.aliases.map(normalizeAlias),
      ]);
      if (keys.has(template.key))
        context.addIssue({
          code: "custom",
          path: ["templates", index, "key"],
          message: "Duplicate or reserved template key.",
        });
      keys.add(template.key);
      for (const alias of names) {
        if (aliases.has(alias))
          context.addIssue({
            code: "custom",
            path: ["templates", index, "aliases"],
            message: "Duplicate or reserved NPC alias.",
          });
        aliases.add(alias);
      }
    }
  });

export type ImportedNpcTemplate = z.infer<typeof templateSchema>;

// Operator-local file only; Discord messages cannot supply a path or catalog.
export function loadNpcTemplates(path?: string): ImportedNpcTemplate[] {
  if (!path) return [];
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 256_000)
    throw new Error("NPC catalog must be a local JSON file up to 256 KB.");
  const content = readFileSync(path, "utf8");
  if (Buffer.byteLength(content, "utf8") > 256_000)
    throw new Error("NPC catalog exceeds 256 KB.");
  return npcCatalogSchema.parse(JSON.parse(content)).templates;
}

// Must run in the registry's existing guild-locked transaction. Import is
// create-only: profile changes must be reviewed and handled explicitly.
export async function installImportedTemplates(
  tx: Database,
  worldId: string,
  templates: readonly ImportedNpcTemplate[],
) {
  for (const template of templates) {
    const [existing] = await tx
      .select()
      .from(discordNpcRegistry)
      .where(
        and(
          eq(discordNpcRegistry.worldId, worldId),
          eq(discordNpcRegistry.templateKey, template.key),
        ),
      );
    const aliases = [
      ...new Set([
        normalizeAlias(template.npc.canonicalName),
        ...template.aliases.map(normalizeAlias),
      ]),
    ].sort();
    if (existing) {
      const npc = await getNpc(tx, worldId, existing.npcId);
      const home = await getEntity(tx, worldId, existing.homeLocationId);
      const savedAliases = await tx.execute<{ normalized_alias: string }>(sql`
        select a.normalized_alias from entity_aliases a
        join entities e on e.id=a.entity_id
        where e.world_id=${worldId} and e.id=${existing.npcId}
        order by a.normalized_alias
      `);
      if (
        !npc ||
        !home ||
        home.entityType !== "location" ||
        !isDeepStrictEqual(
          savedAliases.rows.map((row) => row.normalized_alias).sort(),
          aliases,
        ) ||
        home.canonicalName !== template.home ||
        npc.canonicalName !== template.npc.canonicalName ||
        npc.profileVersion !== template.npc.profileVersion ||
        npc.templateVersion !== template.npc.templateVersion ||
        npc.narrativeWeight !== template.npc.narrativeWeight ||
        npc.simulationDepth !== template.npc.simulationDepth ||
        !isDeepStrictEqual(npc.baselineProfile, template.npc.baselineProfile)
      )
        throw new Error(
          "Existing NPC differs from catalog; explicit profile review required.",
        );
      // An unchanged import must not rewrite state, aliases or profile.
      continue;
    }
    for (const alias of aliases) {
      await lockEntityAlias(tx, worldId, alias);
      if ((await findEntitiesByAlias(tx, worldId, alias)).length)
        throw new Error("NPC catalog alias already exists in this world.");
    }
    if (
      await findEntityByCanonicalName(tx, worldId, template.npc.canonicalName)
    )
      throw new Error("NPC canonical name already exists in this world.");
    const home = await findEntityByCanonicalName(tx, worldId, template.home);
    if (home && (home.entityType !== "location" || home.status !== "active"))
      throw new Error("NPC home must be an active location.");
    const location =
      home ??
      (await createEntity(tx, worldId, {
        entityType: "location",
        canonicalName: template.home,
      }));
    const npc = await createNpc(tx, worldId, {
      ...template.npc,
      initialState: {
        currentLocationId: location.id,
        locationCertainty: "certain",
        availabilityState: { status: "available" },
      },
    });
    for (const alias of aliases)
      await addEntityAlias(tx, worldId, npc.entityId, { alias });
    await tx.insert(discordNpcRegistry).values({
      worldId,
      npcId: npc.entityId,
      templateKey: template.key,
      homeLocationId: location.id,
    });
  }
}
