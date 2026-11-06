import type { LeaseDelta } from '../ports/lease-delta.js';
import type { AskInterruptHandlerNode } from './ask-interrupt-handler-node.js';
import type { BivariantCallback } from './ast-foundation.types.js';
import type { ASTNode } from './ast-node.js';
import type { StepASTNode } from './domain-ast.types.js';
import type { InterruptNode } from './interrupt-node.js';
import type { ReplaceInterruptHandlerNode } from './replace-interrupt-handler-node.js';

/**
 * Conditional capability lease elevation rule evaluated after an adjudicator step produces a verdict.
 *
 * Grants the `LeaseDelta` produced by `leaseMapper` to the interrupted actor when `predicate(input, payload, verdict)` returns `true`.
 *
 * @template TIn      Flow or actor input payload type.
 * @template TPayload Interrupt payload type.
 * @template TVerdict Adjudicator verdict output type.
 */
export interface AdjudicateLeaseElevationConfig<
  TIn = unknown,
  TPayload = unknown,
  TVerdict = unknown,
> {
  /** Synchronous predicate testing whether the adjudicator verdict approves elevating a lease. */
  readonly predicate: BivariantCallback<
    [input: TIn, payload: TPayload, verdict: TVerdict],
    boolean
  >;
  /** Synchronous mapper constructing the `LeaseDelta` granted to the interrupted actor. */
  readonly leaseMapper: BivariantCallback<
    [input: TIn, payload: TPayload, verdict: TVerdict],
    LeaseDelta
  >;
}

/**
 * Interrupt handler variant (`mode: 'adjudicate'`) that dispatches a read-only adjudicator step and resumes the interrupted actor.
 *
 * Supports nested interrupt handlers on the adjudicator (such as escalating a normative contradiction to a human via `.ask()`).
 *
 * @template TIn      Flow or actor input payload type.
 * @template TPayload Interrupt payload type.
 * @template THandle  Runtime handle type of the active isolation scope.
 * @template TVerdict Adjudicator verdict output type.
 */
export interface AdjudicateInterruptHandlerNode<
  TIn = unknown,
  TPayload = unknown,
  THandle = unknown,
  TVerdict = unknown,
> extends ASTNode {
  /** Discriminant identifying an interrupt handler AST node. */
  readonly type: 'harness:interrupt-handler';
  /** Adjudication handler mode. */
  readonly mode: 'adjudicate';
  /** Target `InterruptNode` intercepted by this handler. */
  readonly interrupt: InterruptNode<TPayload>;
  /** Read-only step executable invoked to adjudicate the interrupt. */
  readonly adjudicator: StepASTNode<unknown, TVerdict, THandle>;
  /** Synchronous mapper constructing the adjudicator's input from `(input, payload)`. */
  readonly mapInput: BivariantCallback<[input: TIn, payload: TPayload], unknown>;
  /** Nested interrupt handlers bound on the adjudicator (e.g. escalating a normative contradiction to a human). */
  readonly onInterruptHandlers: ReadonlyArray<
    | AdjudicateInterruptHandlerNode<unknown, unknown, THandle>
    | AskInterruptHandlerNode
    | ReplaceInterruptHandlerNode<unknown, unknown, THandle>
  >;
  /** Optional lease elevation rule applied when the adjudicator approves a lease request. */
  readonly elevateLeaseWhen?: AdjudicateLeaseElevationConfig<TIn, TPayload, TVerdict>;
  /** Synchronous formatter producing the feedback string returned to the interrupted actor on resumption. */
  readonly resumeWith: BivariantCallback<
    [input: TIn, payload: TPayload, verdict: TVerdict],
    string
  >;
}
