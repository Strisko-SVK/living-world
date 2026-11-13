import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { interactions } from "../db/schema/interactions.js";
import {
  evaluatePlayerSummon,
  type SummonDecision,
} from "../communication/summon-availability.js";
import { readNpcSummonFacts } from "../communication/summon-facts.repository.js";
import {
  validateNpcE2eActivationEnvironment,
} from "./discord-npc-e2e-activation.js";
import {
  npcE2eInboundRoute,
  npcE2eInboundTarget,
  verifyNpcE2eInboundFacts,
  type NpcE2eInboundFactsConfig,
} from "./discord-npc-e2e-inbound.js";
import { npcE2eWorldKey } from "./discord-npc-e2e-fixture.js";
import { gatewaySmokeBotId } from "./discord-gateway-smoke.js";

const databaseName = "living_world_gateway_dev";
const databaseRole = "lw_gateway_dev";

export type PostInboundPreviewStatus =
  | "integrity_blocked"
  | "needs_availability_review"
  | "candidate_needs_owner_review"
  | "delayed"
  | "not_available";

export type PostInboundPreview = {
  event: "npc_e2e_response_preview";
  worldKey: typeof npcE2eWorldKey;
  status: PostInboundPreviewStatus;
  availability: SummonDecision["status"] | "not_assessed";
  reason: SummonDecision["reason"] | "integrity_blocked";
  canGenerate: false;
  canSend: false;
  readOnly: true;
};

const blocked = (): PostInboundPreview => ({
  event: "npc_e2e_response_preview",
  worldKey: npcE2eWorldKey,
  status: "integrity_blocked",
  availability: "not_assessed",
  reason: "integrity_blocked",
  canGenerate: false,
  canSend: false,
  readOnly: true,
});

// An existing presence record proves neither conversation availability nor
// authorization to generate or send. Even a candidate requires owner review.
export function classifyPostInboundPreview(
  decision: SummonDecision,
): PostInboundPreview {
  const status: PostInboundPreviewStatus =
    decision.status === "candidate"
      ? "candidate_needs_owner_review"
      : decision.status === "delayed"
        ? "delayed"
        : decision.status === "not_available"
          ? "not_available"
          : "needs_availability_review";
  return {
    event: "npc_e2e_response_preview",
    worldKey: npcE2eWorldKey,
    status,
    availability: decision.status,
    reason: decision.reason,
    canGenerate: false,
    canSend: false,
    readOnly: true,
  };
}

export function parsePostInboundPreviewArguments(
  args: readonly string[],
): void {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return;
  throw new Error("NPC response preview only accepts --preview.");
}

type Database = Omit<DatabaseClient["db"], "$client">;

// Read-only facts projection that can also be exercised against a synthetic
// rollback-only PostgreSQL fixture. It does not prepare or claim a response.
export async function inspectPostInboundPreviewFacts(
  db: Database,
  config: NpcE2eInboundFactsConfig,
): Promise<PostInboundPreview> {
  try {
    const events = await db
      .select({
        sourceMessageId: interactions.sourceMessageId,
      })
      .from(interactions)
      .where(eq(interactions.worldId, config.scope.worldId))
      .limit(2);
    if (events.length !== 1 || !events[0]?.sourceMessageId)
      return blocked();

    // Reuse the exact audited inbound constraints rather than treating the
    // "already_used" fixture status as permission to generate a reply.
    await verifyNpcE2eInboundFacts(
      db,
      config,
      "after",
      events[0].sourceMessageId,
    );
    const facts = await readNpcSummonFacts(db, {
      worldId: config.scope.worldId,
      npcId: config.scope.npcId,
      contextId: config.scope.contextId,
    });
    return facts ? classifyPostInboundPreview(evaluatePlayerSummon(facts)) : blocked();
  } catch {
    // Fixed category: no raw message, IDs, database errors or NPC state
    // details leave the isolated owner operator boundary.
    return blocked();
  }
}

export async function runPostInboundPreviewCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  connect: typeof createDatabaseClient = createDatabaseClient,
): Promise<PostInboundPreview> {
  parsePostInboundPreviewArguments(args);
  const { route, userId } = validateNpcE2eActivationEnvironment(
    environment,
    "activate",
  );
  if (
    !userId ||
    route.guildId !== npcE2eInboundRoute.guildId ||
    route.channelId !== npcE2eInboundRoute.parentId ||
    route.threadId !== npcE2eInboundRoute.threadId
  )
    throw new Error("NPC response preview target is not approved.");

  const config: NpcE2eInboundFactsConfig = {
    botId: gatewaySmokeBotId,
    guildId: route.guildId,
    parentId: route.channelId,
    threadId: route.threadId,
    playerId: userId,
    presenceId: npcE2eInboundTarget.presenceId,
    scope: {
      worldKey: npcE2eWorldKey,
      worldId: npcE2eInboundTarget.worldId,
      npcId: npcE2eInboundTarget.npcId,
      contextId: npcE2eInboundTarget.contextId,
      playerMappingId: npcE2eInboundTarget.playerMappingId,
      policyAuditId: npcE2eInboundTarget.policyAuditId,
    },
  };
  const client = connect(environment);
  try {
    return await client.db.transaction(async (tx) => {
      // Must precede even the identity read. An accidental future write
      // to this CLI will be denied by PostgreSQL itself.
      await tx.execute(sql.raw("set transaction read only"));
      await tx.execute(sql.raw("set local statement_timeout = '8s'"));
      const role = await tx.execute(
        sql.raw(
          "select current_database() as database, current_user as db_role, " +
            "current_setting('server_version_num')::int as version, " +
            "(select rolsuper from pg_roles where rolname=current_user) as superuser, " +
            "(select rolcreatedb from pg_roles where rolname=current_user) as createdb, " +
            "(select rolcreaterole from pg_roles where rolname=current_user) as createrole",
        ),
      );
      const identity = role.rows[0];
      if (
        !identity ||
        identity.database !== databaseName ||
        identity.db_role !== databaseRole ||
        typeof identity.version !== "number" ||
        identity.version < 170000 ||
        identity.version >= 180000 ||
        identity.superuser !== false ||
        identity.createdb !== false ||
        identity.createrole !== false
      )
        throw new Error("NPC response preview requires isolated DEV database.");

      const trigger = await tx.execute(
        sql.raw(
          "select exists (select 1 from pg_trigger t " +
            "join pg_class c on c.oid=t.tgrelid " +
            "join pg_namespace n on n.oid=c.relnamespace " +
            "where t.tgname='discord_route_revision' and t.tgenabled='O' " +
            "and c.relname='discord_context_mappings' " +
            "and n.nspname='public' and not t.tgisinternal) as installed",
        ),
      );
      if (trigger.rows[0]?.installed !== true) return blocked();
      return inspectPostInboundPreviewFacts(tx, config);
    });
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runPostInboundPreviewCommand(process.argv.slice(2)).then(
    (result) => console.info(JSON.stringify(result)),
    () => {
      console.error(
        JSON.stringify({ event: "npc_e2e_response_preview_failed_safely" }),
      );
      process.exitCode = 1;
    },
  );
}
