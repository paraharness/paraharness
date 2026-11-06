import type { z } from 'zod';

/**
 * Structured request payload delivered to a bidirectional `HumanAdapter` when awaiting a human decision.
 *
 * Carries the run and request identifiers, target human role identifier, typed request brief,
 * Zod validation schema for the human's response, optional keep-alive heartbeat interval, and cancellation signal.
 *
 * @template TRequest  Request brief payload type presented to the human.
 * @template TResponse Validated response payload type returned by the human.
 */
export interface HumanDecisionRequest<TRequest = unknown, TResponse = unknown> {
  /** Unique identifier of the enclosing harness run. */
  readonly runId: string;
  /** Deterministic request identifier for idempotency and cancellation tracking. */
  readonly requestId: string;
  /** Identifier of the `H.human` role targeted by this decision request. */
  readonly humanId: string;
  /** Structured decision brief payload presented to the human operator. */
  readonly payload: TRequest;
  /** Zod schema used to validate and parse the human operator's response. */
  readonly responseSchema: z.ZodType<TResponse, z.ZodTypeDef, unknown>;
  /** Optional heartbeat interval in seconds before yielding the concurrency slot. */
  readonly keepAliveSeconds?: number;
  /** Optional abort signal triggered if the decision request is cancelled or superseded. */
  readonly signal?: AbortSignal;
}
