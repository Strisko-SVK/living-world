import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createDatabaseClient } from "../db/client.js";
import { interactionContexts } from "../db/schema/interaction-contexts.js";
import { contextIntakePolicyAudit } from "../db/schema/context-intake-policy-audit.js";
import { npcIntakePolicyValues } from "../db/schema/enums.js";

const requestSchema = z
  .object({
    worldId: z.string().uuid(),
    contextId: z.string().uuid(),
    policy: z.enum(npcIntakePolicyValues),
  })
  .strict();

export function parseContextPolicyArguments(args: readonly string[]) {
  if (
    args.length !== 6 ||
    args[0] !== "--world" ||
    args[2] !== "--context" ||
    args[4] !== "--policy"
  )
    throw new Error(
      "Expected --world UUID --context UUID --policy disabled|mapped_players.",
    );
  const parsed = requestSchema.safeParse({
    worldId: args[1],
    contextId: args[3],
    policy: args[5],
  });
  if (!parsed.success) throw new Error("Invalid context policy request.");
  return parsed.data;
}

// Local operator command only. The authority is trusted host/database access,
// never a claimed Discord/operator ID. Do not import into the intake runtime or
// expose through an HTTP/Discord handler. Dependency injection enables offline tests.
export async function runContextPolicyCommand(
  args: readonly string[],
  connect: typeof createDatabaseClient = createDatabaseClient,
) {
  const request = parseContextPolicyArguments(args);
  const database = connect();
  try {
    return await database.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout='2s'`);
      await tx.execute(sql`set local statement_timeout='5s'`);
      // Conflicts with intake's FOR SHARE until that intake has committed.
      const [context] = await tx
        .select()
        .from(interactionContexts)
        .where(
          and(
            eq(interactionContexts.worldId, request.worldId),
            eq(interactionContexts.id, request.contextId),
          ),
        )
        .for("update");
      if (!context) throw new Error("Context not found in requested world.");
      await tx
        .update(interactionContexts)
        .set({ npcIntakePolicy: request.policy, updatedAt: new Date() })
        .where(
          and(
            eq(interactionContexts.worldId, request.worldId),
            eq(interactionContexts.id, request.contextId),
          ),
        );
      const [audit] = await tx
        .insert(contextIntakePolicyAudit)
        .values({
          id: randomUUID(),
          worldId: request.worldId,
          contextId: request.contextId,
          previousPolicy: context.npcIntakePolicy,
          targetPolicy: request.policy,
        })
        .returning();
      if (!audit) throw new Error("Policy audit persistence failed.");
      return {
        event: "context_intake_policy_updated",
        auditId: audit.id,
        worldId: request.worldId,
        contextId: request.contextId,
        previousPolicy: context.npcIntakePolicy,
        policy: request.policy,
      };
    });
  } finally {
    await database.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runContextPolicyCommand(process.argv.slice(2)).then(
    (audit) => console.info(JSON.stringify(audit)),
    () => {
      // No SQL, credentials, environment values, or raw database errors.
      console.error(
        "Context policy update failed; no success confirmed. Check the database audit before retrying.",
      );
      process.exitCode = 1;
    },
  );
}
