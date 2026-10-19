import type {
  ContextOptions,
  ContextRequest,
  Interaction,
  NpcContextBundle,
} from "../context/context.types.js";
import type {
  FailureCode,
  GenerationRequest,
  GenerationResult,
} from "../llm/contracts.js";

export const PROMPT_VERSION = "npc-speech-v1";
export const CLAIM_LEASE_MS = 600_000;
export interface ResponseScope {
  worldId: string;
  npcId: string;
  interactionId: string;
}
export interface ResponseOptions {
  context?: ContextOptions;
  maxResponseChars?: number;
  maxOutputTokens?: number;
  requestBudgetMicros?: number;
  signal?: AbortSignal;
}
export type ResponseFailure =
  | "invalid_request"
  | "not_found"
  | "ineligible"
  | "visibility_blocked"
  | "context_unavailable"
  | "claim_lost"
  | "invalid_response"
  | "persistence"
  | "cancelled"
  | "generation_failed";
export type ResponseResult =
  | {
      ok: true;
      status: "responded" | "already_recorded";
      interaction: Interaction;
      promptVersion: string | null;
    }
  | { ok: false; error: ResponseFailure; providerError?: FailureCode };
export type Reconciliation =
  | "not_found"
  | "not_claimed"
  | "active"
  | "responded"
  | "reconciled_failed"
  | "reconciled_uncertain"
  | "terminal";
export interface ResponseStore {
  claim(
    scope: ResponseScope,
    expected: Interaction,
  ): Promise<Interaction | null>;
  dispatch(scope: ResponseScope, claimId: string): Promise<boolean>;
  persist(
    scope: ResponseScope,
    claimId: string,
    text: string,
  ): Promise<Interaction | null>;
  fail(
    scope: ResponseScope,
    claimId: string,
    uncertain: boolean,
  ): Promise<void>;
  reconcile(scope: ResponseScope): Promise<Reconciliation>;
}
export interface ResponseDependencies {
  read(scope: ResponseScope): Promise<Interaction | null>;
  build(request: ContextRequest): Promise<NpcContextBundle>;
  store: ResponseStore;
  generate(request: GenerationRequest): Promise<GenerationResult>;
}
export interface ResponseDiagnostic {
  event: "npc_response";
  traceId: string;
  promptVersion: typeof PROMPT_VERSION;
  outcome: ResponseFailure | "responded" | "already_recorded";
}
