import { pathToFileURL } from "node:url";
import { createDatabaseClient } from "../db/client.js";
import { createDeliveryRepository } from "../delivery/delivery.repository.js";
import { createDeliveryDispatcher } from "../delivery/dispatch.js";
import { scopeSchema } from "../delivery/contracts.js";
import {
  authorizeTarget,
  matchesTarget,
  OutboundBlocked,
  readOutboundConfiguration,
  targetSchema,
} from "../adapters/discord-outbound/config.js";
import { createOutboundLimits } from "../adapters/discord-outbound/limits.js";
import {
  verifyDiscordTransport,
  type OutboundHttp,
  type OutboundDiagnostic,
} from "../adapters/discord-outbound/transport.js";
export function parseDeliveryArguments(args: readonly string[]) {
  try {
    const flags = [
      "--world",
      "--npc",
      "--interaction",
      "--guild",
      "--channel",
      "--thread",
    ];
    if (
      (args.length !== 12 && args.length !== 13) ||
      flags.some((flag, i) => args[i * 2] !== flag) ||
      (args.length === 13 &&
        args[12] !== "--execute" &&
        args[12] !== "--dry-run")
    )
      throw Error();
    const scope = scopeSchema.parse({
      worldId: args[1],
      npcId: args[3],
      interactionId: args[5],
    });
    const target = targetSchema.parse({
      worldId: args[1],
      guildId: args[7],
      channelId: args[9],
      threadId: args[11] === "none" ? null : args[11],
    });
    return { scope, target, execute: args[12] === "--execute" };
  } catch {
    throw new OutboundBlocked("invalid_arguments");
  }
}
export interface OperatorDependencies {
  connect?: typeof createDatabaseClient;
  http?: OutboundHttp;
  diagnose?: (event: OutboundDiagnostic) => void;
}
// Trusted host/environment/DB boundary only. Importing never opens a connection.
export async function runDeliveryCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  deps: OperatorDependencies = {},
) {
  let database: ReturnType<typeof createDatabaseClient> | undefined;
  let execute = false;
  try {
    const request = parseDeliveryArguments(args);
    execute = request.execute;
    const config = readOutboundConfiguration(environment);
    const approved = authorizeTarget(config, request.target);
    database = (deps.connect ?? createDatabaseClient)();
    const repository = createDeliveryRepository(database.db, {
      avatars: new Map(
        config.avatars.map((a) => [`${a.worldId}:${a.npcId}`, a.avatarUrl]),
      ),
    });
    const preview = await repository.preview(request.scope);
    if (preview.status !== "ready") throw new OutboundBlocked(preview.reason);
    if (!matchesTarget(preview.payload, request.target, request.scope))
      throw new OutboundBlocked("original_route_mismatch");
    if (!execute)
      return {
        event: "discord_delivery",
        mode: "dry_run",
        status: "ready",
        wouldSend: false,
        bindingVerified: false,
        deliveryStatus: preview.deliveryStatus,
      };
    const limits = createOutboundLimits(database.db);
    const gate = await limits.check(
      approved.binding.webhookId,
      approved.credential.version,
    );
    if (!gate.allowed) throw new OutboundBlocked(gate.reason ?? "rate_limited");
    const verified = await verifyDiscordTransport(
      approved,
      request.scope,
      "execute",
      {
        http: deps.http ?? ((url, init) => fetch(url, init)),
        limits,
        diagnose: deps.diagnose,
      },
    );
    if (verified.status !== "ready") throw new OutboundBlocked(verified.reason);
    // A metadata GET may have exhausted a bucket. Do not claim an outbox item.
    const beforeClaim = await limits.check(
      approved.binding.webhookId,
      approved.credential.version,
    );
    if (!beforeClaim.allowed)
      throw new OutboundBlocked(beforeClaim.reason ?? "rate_limited");
    const prepared = await repository.prepare(request.scope);
    if (prepared.status === "blocked")
      throw new OutboundBlocked(prepared.reason);
    const result = await createDeliveryDispatcher(
      repository,
      verified.transport,
    )(request.scope);
    return {
      event: "discord_delivery",
      mode: "execute",
      status: result.status,
    };
  } catch (error) {
    return {
      event: "discord_delivery",
      mode: execute ? "execute" : "dry_run",
      status: "blocked",
      reason:
        error instanceof OutboundBlocked ? error.reason : "operation_failed",
    };
  } finally {
    if (database) await database.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runDeliveryCommand(process.argv.slice(2), process.env, {
    diagnose: (event) => console.info(JSON.stringify(event)),
  }).then(
    (result) => {
      console.info(JSON.stringify(result));
      if (
        result.status === "blocked" ||
        (result.mode === "execute" && result.status !== "delivered")
      )
        process.exitCode = 1;
    },
    () => {
      console.error(
        "Discord delivery operation failed; inspect durable status before retrying.",
      );
      process.exitCode = 1;
    },
  );
}
