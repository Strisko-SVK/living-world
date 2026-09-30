import { randomUUID } from "node:crypto";

import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createDatabaseClient } from "./client.js";
import { entities } from "./schema/entities.js";
import { interactionContexts } from "./schema/interaction-contexts.js";
import { interactions } from "./schema/interactions.js";
import { npcCapabilities } from "./schema/npc-capabilities.js";
import { npcGameProfiles } from "./schema/npc-game-profiles.js";
import { npcState } from "./schema/npc-state.js";
import { npcs } from "./schema/npcs.js";
import { worlds } from "./schema/worlds.js";
import { createEntity } from "../domains/entity/entity.repository.js";
import {
  completeInteraction,
  createInteraction,
  createInteractionContext,
  failInteraction,
  findInteractionContextByExternalRef,
  getInteraction,
  listInteractionsForNpc,
  markInteractionProcessing,
  recordInteractionResponse,
} from "../domains/interaction/interaction.repository.js";
import {
  peloInteractionFixture,
  peloInteractionResponseFixture,
} from "../domains/interaction/interaction.test-fixture.js";
import { createNpc } from "../domains/npc/npc.repository.js";
import { peloNpcFixture } from "../domains/npc/npc.test-fixture.js";
import { createWorld } from "../domains/world/world.repository.js";

const database = createDatabaseClient();
const worldIds: string[] = [];
const entityIds: string[] = [];
const npcIds: string[] = [];
const contextIds: string[] = [];
const interactionIds: string[] = [];

afterAll(async () => {
  try {
    if (interactionIds.length)
      await database.db
        .delete(interactions)
        .where(inArray(interactions.id, interactionIds));
    if (contextIds.length)
      await database.db
        .delete(interactionContexts)
        .where(inArray(interactionContexts.id, contextIds));
    if (npcIds.length) {
      await database.db
        .delete(npcCapabilities)
        .where(inArray(npcCapabilities.npcId, npcIds));
      await database.db
        .delete(npcGameProfiles)
        .where(inArray(npcGameProfiles.npcId, npcIds));
      await database.db.delete(npcState).where(inArray(npcState.npcId, npcIds));
      await database.db.delete(npcs).where(inArray(npcs.entityId, npcIds));
    }
    if (entityIds.length)
      await database.db.delete(entities).where(inArray(entities.id, entityIds));
    if (worldIds.length)
      await database.db.delete(worlds).where(inArray(worlds.id, worldIds));
  } finally {
    await database.close();
  }
});

describe("interaction persistence", () => {
  it("keeps interaction contexts, lifecycle, and lookups safely world and NPC scoped", async () => {
    const suffix = randomUUID();
    const worldA = await createWorld(database.db, {
      key: `interaction-a-${suffix}`,
      name: "Interaction World A",
      systemType: "test",
    });
    const worldB = await createWorld(database.db, {
      key: `interaction-b-${suffix}`,
      name: "Interaction World B",
      systemType: "test",
    });
    worldIds.push(worldA.id, worldB.id);

    const pelo = await createNpc(database.db, worldA.id, peloNpcFixture);
    const otherNpc = await createNpc(database.db, worldA.id, {
      ...peloNpcFixture,
      canonicalName: `Severian ${suffix}`,
    });
    const foreignNpc = await createNpc(database.db, worldB.id, {
      ...peloNpcFixture,
      canonicalName: `Foreign Pel\`o ${suffix}`,
    });
    npcIds.push(pelo.entityId, otherNpc.entityId, foreignNpc.entityId);
    entityIds.push(pelo.entityId, otherNpc.entityId, foreignNpc.entityId);

    const garak = await createEntity(database.db, worldA.id, {
      entityType: "player_character",
      canonicalName: `Garak ${suffix}`,
    });
    const location = await createEntity(database.db, worldA.id, {
      entityType: "location",
      canonicalName: `Docking Bay ${suffix}`,
    });
    const foreignEntity = await createEntity(database.db, worldB.id, {
      entityType: "player_character",
      canonicalName: `Foreign Garak ${suffix}`,
    });
    entityIds.push(garak.id, location.id, foreignEntity.id);

    await expect(
      createInteractionContext(database.db, worldA.id, {
        contextType: "scene",
        linkedLocationEntityId: foreignEntity.id,
      }),
    ).rejects.toThrow("Linked location entity was not found");
    const context = await createInteractionContext(database.db, worldA.id, {
      contextType: "npc_primary",
      externalProvider: "discord",
      externalGuildId: "guild-1",
      externalChannelId: "channel-1",
      externalThreadId: "thread-1",
      linkedLocationEntityId: location.id,
      metadata: { label: "dock manifest" },
    });
    contextIds.push(context.id);
    await expect(
      findInteractionContextByExternalRef(
        database.db,
        worldA.id,
        "discord",
        "guild-1",
        "channel-1",
        "thread-1",
      ),
    ).resolves.toMatchObject({ id: context.id });
    await expect(
      findInteractionContextByExternalRef(
        database.db,
        worldB.id,
        "discord",
        "guild-1",
        "channel-1",
        "thread-1",
      ),
    ).resolves.toBeNull();

    const foreignContext = await createInteractionContext(
      database.db,
      worldB.id,
      { contextType: "direct" },
    );
    contextIds.push(foreignContext.id);
    await expect(
      createInteraction(database.db, worldA.id, pelo.entityId, {
        ...peloInteractionFixture,
        contextId: foreignContext.id,
      }),
    ).rejects.toThrow("Interaction context was not found");
    await expect(
      createInteraction(database.db, worldA.id, pelo.entityId, {
        ...peloInteractionFixture,
        contextId: context.id,
        speakerEntityId: foreignEntity.id,
      }),
    ).rejects.toThrow("Speaker entity was not found");

    const interaction = await createInteraction(
      database.db,
      worldA.id,
      pelo.entityId,
      {
        ...peloInteractionFixture,
        contextId: context.id,
        speakerEntityId: garak.id,
        sourceMessageId: "message-1",
      },
    );
    expect(interaction).not.toBeNull();
    interactionIds.push(interaction!.id);
    expect(interaction).toMatchObject({
      status: "received",
      traceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    await expect(
      getInteraction(database.db, worldA.id, pelo.entityId, interaction!.id),
    ).resolves.toMatchObject({ id: interaction!.id });
    await expect(
      getInteraction(database.db, worldB.id, pelo.entityId, interaction!.id),
    ).resolves.toBeNull();
    await expect(
      getInteraction(
        database.db,
        worldA.id,
        otherNpc.entityId,
        interaction!.id,
      ),
    ).resolves.toBeNull();

    await expect(
      markInteractionProcessing(
        database.db,
        worldA.id,
        pelo.entityId,
        interaction!.id,
      ),
    ).resolves.toMatchObject({ status: "processing" });
    const responded = await recordInteractionResponse(
      database.db,
      worldA.id,
      pelo.entityId,
      interaction!.id,
      { ...peloInteractionResponseFixture, responseMessageId: "response-1" },
    );
    expect(responded).toMatchObject({
      status: "responded",
      responseText: peloInteractionResponseFixture.responseText,
      responseMessageId: "response-1",
      respondedAt: expect.any(Date),
    });
    await expect(
      recordInteractionResponse(
        database.db,
        worldA.id,
        pelo.entityId,
        interaction!.id,
        { responseText: "Replacement" },
      ),
    ).rejects.toThrow("already been recorded");
    await expect(
      markInteractionProcessing(
        database.db,
        worldA.id,
        pelo.entityId,
        interaction!.id,
      ),
    ).rejects.toThrow("cannot transition");
    await expect(
      completeInteraction(
        database.db,
        worldA.id,
        pelo.entityId,
        interaction!.id,
      ),
    ).resolves.toMatchObject({
      status: "completed",
      completedAt: expect.any(Date),
    });

    const failed = await createInteraction(
      database.db,
      worldA.id,
      pelo.entityId,
      {
        ...peloInteractionFixture,
        contextId: context.id,
        interactionType: "social",
        traceId: randomUUID(),
      },
    );
    interactionIds.push(failed!.id);
    await expect(
      failInteraction(
        database.db,
        worldA.id,
        pelo.entityId,
        failed!.id,
        "No response channel.",
      ),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      failInteraction(database.db, worldA.id, pelo.entityId, failed!.id),
    ).rejects.toThrow("cannot transition");

    await expect(
      listInteractionsForNpc(database.db, worldA.id, pelo.entityId, {
        status: "completed",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: interaction!.id })]);
    await expect(
      listInteractionsForNpc(database.db, worldA.id, pelo.entityId, {
        interactionType: "social",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: failed!.id })]);
  });
});
