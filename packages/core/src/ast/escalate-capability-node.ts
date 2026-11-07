import type { z } from 'zod';
import type { LeaseDelta } from '../ports/lease-delta.js';
import type { BivariantCallback } from './ast-foundation.types.js';
import type { HumanNode } from './human-node.js';
import type { InterruptNode } from './interrupt-node.js';

/**
 * Conditional capability lease elevation rule evaluated when a human authority responds to an `.escalate()` request.
 *
 * Evaluates `predicate(decision)` and, when `true`, applies `leaseMapper(decision)` to the calling
 * agent's active capability lease set before resuming the turn loop.
 *
 * @template TResponse Validated human decision response type.
 */
export interface EscalateLeaseElevationConfig<TResponse = unknown> {
  /** Synchronous predicate testing whether the human decision grants a capability lease. */
  readonly predicate: BivariantCallback<[decision: TResponse], boolean>;
  /** Synchronous mapper constructing the `LeaseDelta` granted to the calling agent. */
  readonly leaseMapper: BivariantCallback<[decision: TResponse], LeaseDelta>;
}

/**
 * Passive AST node representing a voluntary exogenous human escalation capability (`$cap.escalate(interrupt, $esc => ...)`).
 *
 * Exposes a synthetic capability tool named after `interrupt.id` that suspends the calling agent,
 * pages the bidirectional `human` channel, and returns the validated `TResponse` in-band.
 *
 * @template TPayload  Escalation brief payload type validated by `interrupt.schema`.
 * @template TResponse Human decision response type validated by `responseSchema`.
 */
export interface EscalateCapabilityNode<TPayload = unknown, TResponse = unknown> {
  /** Discriminant identifying an exogenous escalation capability AST node. */
  readonly type: 'harness:escalate-capability';
  /** Interrupt definition whose `schema` validates the agent's escalation brief tool call. */
  readonly interrupt: InterruptNode<TPayload>;
  /** Bidirectional human authority paged when the escalation tool is invoked. */
  readonly human: HumanNode<'bidirectional'>;
  /** Zod schema validating the human authority's decision response. */
  readonly responseSchema: z.ZodType<TResponse>;
  /** Optional lease elevation rule applied when the human authority approves a protected mutation. */
  readonly elevateLeaseWhen?: EscalateLeaseElevationConfig<TResponse>;
}
