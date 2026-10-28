export type FailureCode =
  | "disabled"
  | "invalid_request"
  | "authentication"
  | "rate_limit"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "budget"
  | "accounting"
  | "invalid_response"
  | "unsupported_output";
export interface GenerationRequest {
  traceId: string;
  model?: string;
  // Only application-owned instructions belong here. Retrieved text is user data.
  instructions: { system: string; developer?: string };
  messages: Array<{ role: "user"; content: string }>;
  maxOutputTokens?: number;
  temperature?: number;
  requestBudgetMicros?: number;
  responseFormat?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
  // Application authorization before token counting and each provider attempt.
  beforeAttempt?: () => Promise<boolean>;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export interface ProviderRequest {
  model: string;
  messages: Array<{ role: "system" | "developer" | "user"; content: string }>;
  maxOutputTokens: number;
  temperature?: number;
  responseFormat?: { name: string; schema: Record<string, unknown> };
}
export interface ProviderReply {
  text: string;
  usage: Usage | null;
  requestId?: string;
  completed: boolean;
}
export class ProviderFailure extends Error {
  constructor(
    readonly code: FailureCode,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    readonly definitelyUnbilled = false,
  ) {
    super("Text provider request failed.");
    this.name = "ProviderFailure";
  }
}
export interface TextProvider {
  readonly supportsStructuredOutput?: boolean;
  countInput(request: ProviderRequest, signal: AbortSignal): Promise<number>;
  generate(
    request: ProviderRequest,
    signal: AbortSignal,
  ): Promise<ProviderReply>;
}
export interface Reservation {
  id: string;
  traceId: string;
  provider: string;
  model: string;
  currency: string;
  ceiling: bigint;
  reserved: bigint;
  inputRate: bigint;
  outputRate: bigint;
}
export interface Settlement {
  charged: bigint;
  uncertain: boolean;
  usage: Usage | null;
  outcome: string;
  retries: number;
  latencyMs: number;
  requestId?: string;
}
export interface BudgetStore {
  reserve(value: Reservation): Promise<boolean>;
  settle(id: string, value: Settlement): Promise<void>;
}
export interface Observation {
  traceId: string;
  provider: string;
  model: string;
  outcome: FailureCode | "success";
  retries: number;
  latencyMs: number;
  usage: Usage | null;
  currency: string;
  costMicros: string | null;
  costKind: "estimated_from_usage" | "conservative_reservation" | "none";
  reservationMicros?: string;
  reservationOverageMicros?: string;
  estimateExceeded?: boolean;
}
export type GenerationResult =
  | { ok: true; text: string; observation: Observation }
  | { ok: false; error: FailureCode; observation: Observation };
