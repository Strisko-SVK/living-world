import { z } from "zod";
import {
  assessOfflineSpeechReadiness,
  type OfflineSpeechReadinessRequest,
} from "../communication/scene-speech-readiness.js";

// This coordinator must only be composed with a disposable database and a
// FAKE provider/transport in Vitest. It never logs in to Discord, loads a
// token, creates an LLM provider or calls the production outbound adapter.
const scopeSchema = z
  .object({
    worldId: z.string().uuid(),
    npcId: z.string().uuid(),
    contextId: z.string().uuid(),
    interactionId: z.string().uuid(),
  })
  .strict();

export type OfflineSpeechRehearsalScope = z.infer<typeof scopeSchema>;
export type OfflineSpeechRehearsalOutcome =
  | "offline_only"
  | "invalid_scope"
  | "missing_snapshot"
  | "ineligible"
  | "fake_ack"
  | "fake_blocked"
  | "fake_uncertain";

export interface OfflineSpeechRehearsalDependencies {
  // Must return the original authenticated, uniquely mapped Discord event,
  // current NPC state, unchanged local presence and an independently
  // authorized, non-revoked scene policy from the trusted repository.
  readTrustedSnapshot(
    scope: OfflineSpeechRehearsalScope,
  ): Promise<OfflineSpeechReadinessRequest | null>;
  // Must be fake generation + fake transport ACK, never a real Discord send.
  runFake(
    scope: OfflineSpeechRehearsalScope,
  ): Promise<"ack" | "blocked" | "uncertain">;
  diagnose?: (event: {
    event: "npc_speech_rehearsal";
    outcome: OfflineSpeechRehearsalOutcome;
  }) => void;
}

export function createOfflineSpeechRehearsal(
  deps: OfflineSpeechRehearsalDependencies,
) {
  return async (raw: OfflineSpeechRehearsalScope) => {
    const finish = (outcome: OfflineSpeechRehearsalOutcome) => {
      try {
        deps.diagnose?.({ event: "npc_speech_rehearsal", outcome });
      } catch {
        // Diagnostics cannot change authorization or permit a retry.
      }
      return outcome;
    };
    if (
      process.env.NODE_ENV !== "test" ||
      process.env.DISCORD_ENABLED === "true" ||
      process.env.DISCORD_OUTBOUND_ENABLED === "true" ||
      process.env.LLM_PROVIDER === "openai"
    )
      return finish("offline_only");
    const parsed = scopeSchema.safeParse(raw);
    if (!parsed.success) return finish("invalid_scope");

    let fakeStarted = false;
    try {
      const scope = parsed.data;
      const snapshot = await deps.readTrustedSnapshot(scope);
      if (!snapshot) return finish("missing_snapshot");
      if (
        snapshot.worldId !== scope.worldId ||
        snapshot.npcId !== scope.npcId ||
        snapshot.contextId !== scope.contextId ||
        snapshot.interactionId !== scope.interactionId
      )
        return finish("ineligible");

      const readiness = assessOfflineSpeechReadiness(snapshot);
      if (!readiness.canRehearseFake) return finish("ineligible");

      fakeStarted = true;
      const fake = await deps.runFake(scope);
      return finish(
        fake === "ack"
          ? "fake_ack"
          : fake === "uncertain"
            ? "fake_uncertain"
            : "fake_blocked",
      );
    } catch {
      // An exception after fake invocation could mean an uncertain ACK.
      // Never automatically retry even the fake adapter.
      return finish(fakeStarted ? "fake_uncertain" : "ineligible");
    }
  };
}
