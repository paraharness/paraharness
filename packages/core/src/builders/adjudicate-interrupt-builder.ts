import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type {
  AdjudicateInterruptHandlerNode,
  InterruptHandlerNode,
} from '../ast/interrupt-handler-node.types.js';
import type { InterruptNode } from '../ast/interrupt-node.js';
import type { LeaseDelta } from '../ports/lease-delta.js';
import type { InterruptEdgeBuilder } from './interrupt-edge-builder.js';

/**
 * Fluent sub-builder for an adjudicator-backed `.onInterrupt()` handler (`$intr.adjudicateWith(...)`).
 *
 * Configures nested adjudicator interrupt handlers, conditional capability lease elevations,
 * and the required `.resumeWith(formatter)` feedback callback.
 *
 * @template TIn      Flow or actor input payload type.
 * @template TPayload Interrupt payload type.
 * @template THandle  Runtime handle type of the active isolation scope.
 * @template TVerdict Adjudicator verdict output type.
 */
export interface AdjudicateInterruptBuilder<
  TIn = unknown,
  TPayload = unknown,
  THandle = unknown,
  TVerdict = unknown,
> extends AstBuilder<AdjudicateInterruptHandlerNode<TIn, TPayload, THandle, TVerdict>> {
  /**
   * Binds a nested interrupt handler on the adjudicator step (e.g. escalating a normative contradiction to a human).
   *
   * Appends the compiled nested `InterruptHandlerNode` to `onInterruptHandlers`.
   *
   * @template TSubPayload Nested interrupt payload type.
   *
   * @param {MaybeBuilder<InterruptNode<TSubPayload>>}                                                                                       subInterrupt - Nested interrupt node or builder.
   * @param {($sub: InterruptEdgeBuilder<unknown, TSubPayload, THandle>) => AstBuilder<InterruptHandlerNode<unknown, TSubPayload, THandle>>} configure    - Nested edge configurator.
   *
   * @returns {AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict>} New immutable adjudicate builder.
   */
  onInterrupt<TSubPayload>(
    subInterrupt: MaybeBuilder<InterruptNode<TSubPayload>>,
    configure: (
      $sub: InterruptEdgeBuilder<unknown, TSubPayload, THandle>,
    ) => AstBuilder<InterruptHandlerNode<unknown, TSubPayload, THandle>>,
  ): AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict>;

  /**
   * Registers a conditional capability lease elevation rule evaluated when the adjudicator produces a verdict.
   *
   * Grants the `LeaseDelta` returned by `leaseMapper` whenever `predicate(input, payload, verdict)` returns `true`.
   *
   * @param {(input: TIn, payload: TPayload, verdict: TVerdict) => boolean}    predicate   - Predicate testing whether a lease should be granted.
   * @param {(input: TIn, payload: TPayload, verdict: TVerdict) => LeaseDelta} leaseMapper - Mapper producing the `LeaseDelta` to grant.
   *
   * @returns {AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict>} New immutable adjudicate builder.
   */
  elevateLeaseWhen(
    predicate: (input: TIn, payload: TPayload, verdict: TVerdict) => boolean,
    leaseMapper: (input: TIn, payload: TPayload, verdict: TVerdict) => LeaseDelta,
  ): AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict>;

  /**
   * Binds the synchronous formatter producing the feedback string returned to the interrupted actor on resumption.
   *
   * Required before `.toAST()` can compile a valid `AdjudicateInterruptHandlerNode`.
   *
   * @param {(input: TIn, payload: TPayload, verdict: TVerdict) => string} formatter - Resumption feedback formatter.
   *
   * @returns {AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict>} New immutable adjudicate builder.
   */
  resumeWith(
    formatter: (input: TIn, payload: TPayload, verdict: TVerdict) => string,
  ): AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict>;
}

export type { AdjudicateInterruptBuilder as AdjudicateInterruptEdgeBuilder };
