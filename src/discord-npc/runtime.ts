import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getNpcWithState, updateNpcState } from "../domains/npc/npc.repository.js";
import { getTask, listTasksForAssignee, listTaskReports, createTaskReport, transitionTask } from "../domains/task/task.repository.js";
import { loadNpcTemplates } from "./template-catalog.js";
import type { IncomingMessage } from "../intake/discord-intake.js";
import { parseDiscordTrigger } from "../intake/discord-trigger.js";
import { discordMessageCreatedAt } from "../intake/discord-snowflake.js";
import { normalizeAlias } from "../domains/entity/alias-normalizer.js";
import { createRaonConversation } from "../admin/raon-conversation.js";
import { createRaonDevTurn, raonSourceAgeMs } from "../admin/raon-dev-turn.js";
import { postScopedBotReply } from "../admin/dev-first-reply-transport.js";
import { createRaonWebhookManager } from "../admin/raon-webhooks.js";
import {
  campaignCategoryApproved,
  createNpcScenes,
  ensureSceneSpeech,
} from "./scenes.js";
import {
  createNpcRegistry,
  nativeWorldPrefix,
  type Database,
  type SceneRoute,
} from "./registry.js";

export type NpcCommand =
  | { action: "register" | "register-here" | "list" | "bases" | "install" }
  | {
      action: "enable" | "disable" | "reassign" | "status" | "info" | "scene";
      alias: string;
    }
  | { action: "availability"; alias: string; availability: "available" | "busy" | "unavailable" }
  | { action: "summon"; alias: string; reason: string }
  | { action: "return-home" | "tasks"; alias: string }
  | { action: "task-update"; taskId: string; status: "accepted" | "active" | "blocked" | "completed" | "failed" | "cancelled"; reason?: string }
  | { action: "task-report"; taskId: string }
  | { action: "access"; targetId: string; role: "dm" | "player" | "remove" }
  | { action: "invalid" };

export function parseMentionCommand(
  message: IncomingMessage,
  botId: string,
): NpcCommand | null {
  const explicit = parseDiscordTrigger(
    message.content,
    botId,
    message.mentionedUserIds,
  );
  if (explicit?.body.startsWith("{")) {
    const action = /^\{(enable|disable|reassign|status|info|scene)\}$/iu
      .exec(explicit.body)?.[1]
      ?.toLowerCase();
    if (
      action === "enable" ||
      action === "disable" ||
      action === "reassign" ||
      action === "status" ||
      action === "info" ||
      action === "scene"
    )
      return { action, alias: explicit.alias };
    return { action: "invalid" };
  }
  if (!message.mentionedUserIds.includes(botId)) return null;
  const root =
    /^<@!?(\d{17,20})>\s+\{(register|register-here|list|bases|install)\}$/iu.exec(
      message.content,
    );
  if (root?.[1] !== botId) return null;
  const action = root[2].toLowerCase();
  if (
    action === "register" ||
    action === "register-here" ||
    action === "list" ||
    action === "bases" ||
    action === "install"
  )
    return { action };
  return null;
}

const feedback: Record<string, string> = {
  enabled: "The channel is registered.",
  already_enabled: "The channel is already registered.",
  disabled: "Base disabled. NPC and scene history are retained.",
  already_disabled: "This base is already disabled.",
  reassigned:
    "Base reassigned. The previous channel and its history are retained.",
  forbidden: "This operation requires a Living World DM or administrator.",
  base_conflict:
    "This NPC already has a base. Use /npc reassign in the new channel.",
  channel_conflict: "This channel already belongs to another scene or NPC.",
  unapproved_channel: "Use a text channel inside the approved roleplay area.",
  unregistered_channel: "This channel is not the registered base for that NPC.",
};

export type DiscordSceneAccess = {
  categoryId: string | null;
  ownerId: string;
  threadOwnerId?: string;
};
export type NativeDiscordPort = {
  inspect(
    route: SceneRoute,
    userId?: string,
    manage?: boolean,
  ): Promise<DiscordSceneAccess | null>;
  guildOwner(guildId: string, userId: string): Promise<boolean>;
  guildUser(guildId: string, userId: string): Promise<boolean>;
  feedback(message: IncomingMessage, content: string): Promise<void>;
};
type Diagnostic = (event: { event: string; outcome?: string }) => void;

export function createNativeNpcRuntime(
  db: Database,
  config: {
    guildId: string;
    botId: string;
    token: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    port: NativeDiscordPort;
    diagnose: Diagnostic;
    startedAt: number;
    http?: typeof fetch;
    inferenceHttp?: typeof fetch;
  },
) {
  const since = config.env.LW_NPC_CONTEXT_SINCE;
  const sinceMs = since ? Date.parse(since) : undefined;
  if (
    sinceMs !== undefined &&
    (!Number.isSafeInteger(sinceMs) ||
      sinceMs < 1420070400000 ||
      sinceMs > Date.now())
  )
    throw new Error(
      "Invalid LW_NPC_CONTEXT_SINCE; use a past UTC ISO timestamp.",
    );
  const historyStartSourceId =
    sinceMs === undefined
      ? undefined
      : ((BigInt(sinceMs) - 1420070400000n) << 22n).toString();
  const registry = createNpcRegistry(
    db,
    config.guildId,
    loadNpcTemplates(config.env.LW_NPC_TEMPLATE_FILE),
  );
  const scenes = createNpcScenes(db, registry);
  const webhooks = new Map<
    string,
    ReturnType<typeof createRaonWebhookManager>
  >();
  const allowed = (route: SceneRoute) =>
    !config.signal.aborted && route.guildId === config.guildId;
  const sourceTime = (message: IncomingMessage) => {
    const when = discordMessageCreatedAt(message.sourceMessageId);
    return when !== null &&
      when >= config.startedAt &&
      when <= Date.now() &&
      Date.now() - when <= raonSourceAgeMs
      ? when
      : null;
  };
  let queued = 0;
  let controls = 0;
  let admissions = 0;
  let admission = Promise.resolve();
  let queue = Promise.resolve();
  const report = (event: string, outcome: string) =>
    config.diagnose({ event, outcome });

  async function webhookFor(
    route: SceneRoute,
    authorize: () => Promise<boolean>,
  ) {
    let manager = webhooks.get(route.channelId);
    if (!manager) {
      // Prevent unbounded credential caches; the registry retains only webhook IDs.
      if (webhooks.size >= 128) webhooks.delete(webhooks.keys().next().value!);
      manager = createRaonWebhookManager({
        route,
        botId: config.botId,
        token: config.token,
        signal: config.signal,
        http: config.http,
        canManage: async () =>
          !!(await config.port.inspect(
            { ...route, threadId: null },
            undefined,
            true,
          )),
        diagnose: config.diagnose,
      });
      webhooks.set(route.channelId, manager);
    }
    const webhook = await manager(authorize);
    if (webhook) await scenes.recordWebhook(route, webhook.id);
    return webhook;
  }

  async function command(route: SceneRoute, userId: string, input: NpcCommand) {
    if (!allowed(route)) return "Living World is unavailable in this guild.";
    const access = await config.port.inspect(route, userId);
    if (!access)
      return "Living World cannot verify access to this channel. Check the channel permissions.";
    if (input.action === "register" || input.action === "register-here") {
      if (
        route.threadId ||
        !(await config.port.guildOwner(route.guildId, userId))
      )
        return "The Discord server owner must register from a text channel.";
      if (input.action === "register-here" && !access.categoryId)
        return "Run this command inside the category to approve.";
      const result = await registry.bootstrap(
        route.guildId,
        userId,
        input.action === "register-here" ? access.categoryId : null,
      );
      report("native_campaign", result);
      return result === "registered" || result === "already_registered"
        ? "Living World is registered. Quartermaster and Sentinel are available in /npc list. Use /npc access to grant campaign access."
        : "This guild already has a different campaign registration.";
    }
    const campaign = await registry.campaign(route.guildId);
    if (!campaign)
      return "Living World is not registered. The server owner can use /npc register.";
    const member = await registry.member(campaign.worldId, userId);
    if (!member)
      return "A Living World administrator must grant you campaign access.";
    if (input.action === "access") {
      if (
        member.role !== "admin" ||
        (input.role !== "remove" &&
          !(await config.port.guildUser(route.guildId, input.targetId)))
      )
        return "Only a Living World administrator can change access for a human member of this guild.";
      return (await registry.grant(
        campaign,
        userId,
        input.targetId,
        input.role,
      ))
        ? "Campaign access updated."
        : "Campaign access was not changed.";
    }
    if (input.action === "install") {
      if (member.role !== "admin")
        return "Only a Living World administrator can install catalog templates.";
      return (await registry.install(campaign, userId))
        ? "All available templates are installed."
        : "Template installation was blocked.";
    }
    const roster = await registry.roster(campaign.worldId);
    if (input.action === "task-update" || input.action === "task-report") {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.taskId))
        return "Invalid task identifier.";
      const task = await getTask(db,campaign.worldId,input.taskId);
      if (!task || !roster.some(npc=>npc.npcId===task.assigneeEntityId))
        return "Task not found in this campaign.";
      if (input.action==="task-report") {
        if (member.role==="player" && task.requesterEntityId!==member.entity_id)
          return "This task is unavailable.";
        const reports=await listTaskReports(db,campaign.worldId,task.id);
        return reports.length
          ? reports.slice(-3).map(report=>report.reportType+": "+report.reportText.slice(0,450)).join("\n")
          : "No report exists. Current task status: "+task.status+".";
      }
      if (member.role==="player") return feedback.forbidden;
      if (!campaignCategoryApproved(campaign,access.categoryId))
        return feedback.unapproved_channel;
      if ((input.status==="blocked" || input.status==="completed") &&
          (!input.reason || input.reason.trim().length<5))
        return "A meaningful reason or result is required.";
      try {
        await db.transaction(async tx=>{
          const updated=await transitionTask(tx,campaign.worldId,task.id,{
            status:input.status,
            ...(input.status==="blocked"?{blockedReason:input.reason}:{}),
            ...(input.status==="completed"?{resultSummary:input.reason}:{}),
          });
          if (!updated) throw new Error("task_not_found");
          if (["blocked","completed","failed","cancelled"].includes(input.status))
            await createTaskReport(tx,campaign.worldId,task.id,{
              recipientEntityId:task.requesterEntityId,
              contextId:task.originContextId,
              reportType:input.status==="completed"?"completion":
                input.status==="blocked"?"progress":"failure",
              reportText:input.reason?.trim().slice(0,1000) ??
                ("Task status: "+input.status),
            });
        });
        report("native_task",input.status);
        return "Task "+task.id+" is now "+input.status+". The report is stored and can be viewed with /npc task-report.";
      } catch {
        return "Task transition rejected; check the current status and reason.";
      }
    }
    if (input.action === "list")
      return roster.length
        ? roster
            .map((npc) => npc.name + " (" + npc.template + ")")
            .join(", ")
            .slice(0, 1800)
        : "No NPCs are registered.";
    if (input.action === "bases") {
      const registered = await scenes.visibleBases(
        campaign.worldId,
        userId,
        config.port.inspect,
      );
      const lines = registered.flatMap((base) => {
        const npc = roster.find((entry) => entry.npcId === base.baseNpcId);
        return npc ? [npc.name + " · <#" + base.channelId + ">"] : [];
      });
      return lines.length
        ? lines.join("\n").slice(0, 1800)
        : "No accessible NPC bases are enabled.";
    }
    if (!("alias" in input)) return "Use /npc for supported operations.";
    const matches = roster.filter((npc) =>
      npc.aliases.includes(normalizeAlias(input.alias)),
    );
    if (matches.length !== 1)
      return matches.length
        ? "More than one NPC matches that name."
        : "NPC not found. Use /npc list.";
    const [npc] = matches;
    if (input.action === "tasks") {
      if (!campaignCategoryApproved(campaign,access.categoryId))
        return feedback.unapproved_channel;
      const all = await listTasksForAssignee(db,campaign.worldId,npc.npcId);
      const visible = member.role==="player"
        ? all.filter(task=>task.requesterEntityId===member.entity_id)
        : all;
      return visible.length
        ? visible.slice(-8).map(task=>
            task.id+" · "+task.status+" · "+task.objective.slice(0,100)
          ).join("\n").slice(0,1850)
        : "No visible tasks for this NPC.";
    }
    if (input.action === "availability" || input.action === "summon" || input.action === "return-home") {
      if (member.role==="player") return feedback.forbidden;
      if (!campaignCategoryApproved(campaign,access.categoryId))
        return feedback.unapproved_channel;
      const bases=await registry.parents(campaign.worldId);
      const parent=await scenes.parent(route);
      if (!parent?.active || parent.worldId!==campaign.worldId)
        return "Use an active registered NPC base or scene.";
      if (input.action==="availability" || input.action==="return-home") {
        if (parent.baseNpcId!==npc.npcId)
          return "Use this NPC's registered base channel.";
      } else {
        if (parent.baseNpcId!==null || !route.threadId ||
            input.reason.trim().length<10 || input.reason.length>400)
          return "Summon from a registered shared-scene thread with a narrative reason (10–400 characters).";
      }
      const snapshot=await getNpcWithState(db,campaign.worldId,npc.npcId);
      if (!snapshot?.state || snapshot.npc.lifecycleState!=="active")
        return "NPC cannot be moved or made available in its current lifecycle.";
      const expectedVersion=snapshot.state.version;
      try {
        const updated=await updateNpcState(db,campaign.worldId,npc.npcId,
          input.action==="availability"
            ? {availabilityState:{status:input.availability},expectedVersion}
            : {
                currentLocationId:input.action==="summon"?parent.locationId:npc.home_id,
                locationCertainty:"certain",
                availabilityState:{status:"available"},
                expectedVersion,
              });
        if (!updated) return "NPC unavailable.";
        report("native_presence",input.action);
        return npc.name+" · "+(input.action==="availability"
          ? input.availability
          : input.action==="summon"?"summoned to this scene":"returned home")+
          ". Existing presence evidence has been invalidated.";
      } catch {
        return "Presence changed concurrently. Retry after checking /npc status.";
      }
    }
    if (input.action === "info" || input.action === "status") {
      const base = (await registry.parents(campaign.worldId)).find(
        (entry) => entry.active && entry.baseNpcId === npc.npcId,
      );
      const canView =
        base &&
        (await config.port.inspect(
          { guildId: base.guildId, channelId: base.channelId, threadId: null },
          userId,
        ));
      const status =
        npc.lifecycle !== "active"
          ? npc.lifecycle
          : npc.location !== npc.home
            ? "away from base"
            : npc.availability;
      return (
        npc.name +
        " · " +
        status +
        ". " +
        (canView ? "Base <#" + base.channelId + ">." : "No accessible base.")
      );
    }
    if (member.role === "player") return feedback.forbidden;
    if (
      route.threadId ||
      !campaignCategoryApproved(campaign, access.categoryId)
    )
      return feedback.unapproved_channel;
    if (
      input.action !== "disable" &&
      !(await config.port.inspect(route, userId, true))
    )
      return "Grant the bot Manage Webhooks and access to this text channel, then retry.";
    const outcome = await scenes.configure(
      campaign,
      userId,
      route,
      access.categoryId,
      npc,
      input.action,
    );
    report("native_base", outcome);
    if (!["enabled", "already_enabled", "reassigned"].includes(outcome))
      return feedback[outcome] ?? "Registration could not be updated.";
    const authorize = async () => {
      const current = await scenes.parent(route);
      const verified = await config.port.inspect(route, userId, true);
      const authority = await registry.member(campaign.worldId, userId);
      return !!(
        current?.active &&
        current.worldId === campaign.worldId &&
        verified &&
        campaignCategoryApproved(campaign, verified.categoryId) &&
        authority &&
        authority.role !== "player"
      );
    };
    const webhook = await webhookFor(route, authorize);
    const availability =
      npc.lifecycle === "active" && npc.location === npc.home
        ? npc.availability
        : "away or unavailable";
    return (
      feedback[outcome] +
      " " +
      npc.name +
      " · <#" +
      route.channelId +
      "> · " +
      availability +
      ". " +
      (webhook
        ? input.action === "scene"
          ? "Use an explicit NPC mention to start."
          : "Create a thread and start talking."
        : "Webhook setup is pending. Check bot permissions and retry the command.")
    );
  }

  async function incoming(message: IncomingMessage, botId: string) {
    if (
      !allowed(message) ||
      botId !== config.botId ||
      sourceTime(message) === null
    )
      return "ignored";
    const operation = parseMentionCommand(message, botId);
    if (operation) {
      if (controls >= 4) return "control_queue_full";
      controls++;
      try {
        // Only explicit operations receive bot-channel feedback.
        if (!(await config.port.inspect(message, message.authorId)))
          return "ignored";
        const content = await command(message, message.authorId, operation);
        await config.port.feedback(message, content);
        return "command";
      } finally {
        controls--;
      }
    }
    if (/^(?:\/\/|\(\(|\[ooc\]|ooc\s*:)/iu.test(message.content))
      return "out_of_character";
    if (
      /<(?:@!?\d+|@&\d+|#\d+)>/u.test(message.content) &&
      !parseDiscordTrigger(message.content, botId, message.mentionedUserIds)
    )
      return "other_address";
    // Commit admission order before asynchronous DB reads. Ignore other
    // channels and unmapped members without consuming model queue slots.
    if (admissions >= 24) return "admission_full";
    admissions++;
    const admitted = admission
      .then(async () => {
        const campaign = await registry.campaign(message.guildId);
        if (!campaign) return { outcome: "ignored" };
        const approved = await scenes.parent(message);
        if (!approved?.active || approved.worldId !== campaign.worldId)
          return { outcome: "ignored" };
        if (!(await registry.member(campaign.worldId, message.authorId)))
          return { outcome: "ignored" };
        if (queued >= 8) {
          report("native_queue", "full");
          return { outcome: "queue_full" };
        }
        queued++;
        const work = queue.then(() => runTurn(message)).finally(() => queued--);
        queue = work.then(
          () => {},
          () => report("native_turn", "operation_failed"),
        );
        return { work };
      })
      .finally(() => admissions--);
    admission = admitted.then(
      () => {},
      () => report("native_admission", "operation_failed"),
    );
    const decision = await admitted;
    if (!decision.work) return decision.outcome;
    const work = decision.work;
    const outcome = await work;
    report("native_turn", outcome ?? "unaccepted");
    return outcome;
  }

  async function runTurn(message: IncomingMessage) {
    if (!allowed(message) || sourceTime(message) === null) return "ignored";
    const campaign = await registry.campaign(message.guildId);
    const approved = await scenes.parent(message);
    if (!campaign || !approved?.active || approved.worldId !== campaign.worldId)
      return "ignored";
    const actor = await registry.member(campaign.worldId, message.authorId);
    const issuer = await registry.member(
      campaign.worldId,
      campaign.ownerUserId,
    );
    if (!actor || issuer?.role !== "admin") return "ignored";
    const access = await config.port.inspect(message, message.authorId);
    if (!access || !campaignCategoryApproved(campaign, access.categoryId))
      return "discord_acl_blocked";
    if (
      message.threadId &&
      access.threadOwnerId !== config.botId &&
      (!access.threadOwnerId ||
        !(await registry.member(campaign.worldId, access.threadOwnerId)))
    )
      return "discord_acl_blocked";
    const explicit = parseDiscordTrigger(
      message.content,
      config.botId,
      message.mentionedUserIds,
    );
    const authorizeRoute = async () => {
      const when = sourceTime(message);
      if (when === null || !allowed(message)) return false;
      return scenes.sourceAllowed(
        approved,
        message,
        actor.entity_id,
        when,
        issuer.entity_id,
      );
    };
    if (!(await authorizeRoute())) return "ignored";
    // Verify Discord's current copy before a fresh source can initialize a
    // scene or cause policy/evidence creation.
    const precheck = await postScopedBotReply(
      {
        guildId: message.guildId,
        parentId: message.channelId,
        threadId: message.threadId,
        sourceMessageId: message.sourceMessageId,
        playerId: message.authorId,
        botId: config.botId,
        attemptId: randomUUID(),
      },
      {
        token: config.token,
        http: config.http ?? fetch,
        dryRun: true,
        revalidateAtBoundary: authorizeRoute,
      },
      {
        content: "Preflight",
        sourceContent: message.content,
        conversationSource: {
          mentioned: !!explicit,
          replyToMessageId: message.replyToMessageId,
        },
        verifyPermissions: async () => {
          const current = await config.port.inspect(message, message.authorId);
          return (
            !!current && campaignCategoryApproved(campaign, current.categoryId)
          );
        },
        signal: config.signal,
      },
    );
    if (precheck.status !== "prechecked") return "discord_acl_blocked";
    const scene = await scenes.discover(approved, message);
    if (!scene) return "unmapped";
    const scope = {
      ...scene,
      worldKey: nativeWorldPrefix + campaign.guildId,
      playerEntityId: actor.entity_id,
    };
    const roster = await registry.roster(scene.worldId);
    const defaultNpcId = message.threadId ? approved.baseNpcId : null;
    const memory = createRaonConversation(db, scope, 600_000, {
      defaultNpcId,
      explicitOnly: !defaultNpcId,
      experimentalHistory: config.env.LW_NPC_DIALOGUE_VERSION === "m219-v1",
      historyStartSourceId,
    });
    const resolution = await memory.select(message, config.botId, roster);
    if (resolution.kind === "closed" && (await authorizeRoute()))
      await memory.focus(message, null);
    if (resolution.kind !== "selected") return resolution.kind;
    const speech = await ensureSceneSpeech(
      db,
      scene,
      resolution.npcId,
      issuer.entity_id,
    );
    if (!speech) {
      if (resolution.via === "name" && (await authorizeRoute()))
        await config.port.feedback(
          message,
          "That NPC is unavailable in this scene.",
        );
      return "npc_unavailable";
    }
    const turn = createRaonDevTurn(db, config.env, {
      fixture: {
        ...scope,
        npcId: resolution.npcId,
        presenceId: speech.presenceId,
      },
      route: message,
      playerId: message.authorId,
      botId: config.botId,
      hostEntityId: issuer.entity_id,
      policyId: speech.policyId,
      token: config.token,
      signal: config.signal,
      startedAt: config.startedAt,
      native: { authorizeRoute },
      verifyPermissions: async () => {
        const actual = await config.port.inspect(message, message.authorId);
        return (
          !!actual && campaignCategoryApproved(campaign, actual.categoryId)
        );
      },
      resolveWebhook: (authorize) => webhookFor(message, authorize),
      diagnose: config.diagnose,
      http: config.http,
      inferenceHttp: config.inferenceHttp,
    });
    return turn(message, config.botId, { ...resolution, memory });
  }

  async function threadCreated(route: SceneRoute, ownerId: string) {
    if (!allowed(route) || !route.threadId) return;
    const parent = await scenes.parent(route);
    const campaign = await registry.campaign(route.guildId);
    if (
      !parent?.active ||
      !campaign ||
      parent.worldId !== campaign.worldId ||
      !(await registry.member(campaign.worldId, ownerId))
    )
      return;
    const access = await config.port.inspect(route, ownerId);
    if (
      access?.threadOwnerId === ownerId &&
      campaignCategoryApproved(campaign, access.categoryId)
    )
      await scenes.discover(parent, route);
  }

  return {
    command,
    incoming,
    threadCreated,
    deleted: (route: SceneRoute) =>
      allowed(route) ? scenes.deleted(route) : Promise.resolve(),
    drain: () => queue,
  };
}
