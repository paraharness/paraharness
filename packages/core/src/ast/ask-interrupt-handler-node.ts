import type { z } from 'zod';
import type { LeaseDelta } from '../ports/lease-delta.js';
import type { BivariantCallback } from './ast-foundation.types.js';
import type { ASTNode } from './ast-node.js';
import type { HumanNode } from './human-node.js';
import type { InterruptNode } from './interrupt-node.js';

/**
 * Conditional capability lease elevation rule evaluated after a human authority responds to an `.ask()` interrupt handler.
 *
 * Grants the `LeaseDelta` produced by `leaseMapper` to the outer interrupted actor when `predicate(decision)` returns `true`.
 *
 * @template TDecision Validated human decision response type.
 */
export interface AskLeaseElevationConfig<TDecision = unknown> {
  /** Synchronous predicate testing whether the human decision approves elevating a lease. */
  readonly predicate: BivariantCallback<[decision: TDecision], boolean>;
  /** Synchronous mapper constructing the `LeaseDelta` granted to the interrupted actor. */
  readonly leaseMapper: BivariantCallback<[decision: TDecision], LeaseDelta>;
}

/**
 * Interrupt handler variant (`mode: 'ask'`) that pages a bidirectional `HumanNode` and resumes the interrupted actor.
 *
 * Suspends the active actor or adjudicator until the human authority submits a response matching `responseSchema`.
 *
 * @template TPayload  Interrupt payload type.
 * @template TDecision Validated human decision response type.
 */
export interface AskInterruptHandlerNode<TPayload = unknown, TDecision = unknown> extends ASTNode {
  /** Discriminant identifying an interrupt handler AST node. */
  readonly type: 'harness:interrupt-handler';
  /** Human decision handler mode. */
  readonly mode: 'ask';
  /** Target `InterruptNode` intercepted by this handler. */
  readonly interrupt: InterruptNode<TPayload>;
  /** Bidirectional human authority paged to resolve the interrupt. */
  readonly human: HumanNode<'bidirectional'>;
  /** Zod schema validating the human's decision response. */
  readonly responseSchema: z.ZodType<TDecision>;
  /** Optional lease elevation rule applied to the outer interrupted actor when the human approves a lease. */
  readonly elevateLeaseWhen?: AskLeaseElevationConfig<TDecision>;
  /** Synchronous formatter producing the feedback string returned to the interrupted actor or adjudicator. */
  readonly resumeWith: BivariantCallback<[decision: TDecision], string>;
}
