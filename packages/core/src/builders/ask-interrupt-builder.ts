import type { AstBuilder } from '../ast/ast-builder.js';
import type { AskInterruptHandlerNode } from '../ast/interrupt-handler-node.types.js';
import type { LeaseDelta } from '../ports/lease-delta.js';

/**
 * Fluent sub-builder for a human-backed `.onInterrupt()` handler (`$intr.ask(human, responseSchema)`).
 *
 * Configures optional capability lease elevations and the mandatory `.resumeWith(formatter)`
 * feedback callback for an `ask`-mode interrupt edge.
 *
 * @template TPayload  Interrupt payload type.
 * @template TDecision Validated human decision response type.
 */
export interface AskInterruptBuilder<TPayload = unknown, TDecision = unknown>
  extends AstBuilder<AskInterruptHandlerNode<TPayload, TDecision>> {
  /**
   * Registers a conditional capability lease elevation rule evaluated when the human authority responds.
   *
   * Grants the `LeaseDelta` returned by `leaseMapper(decision)` whenever `predicate(decision)` returns `true`.
   *
   * @param {(decision: TDecision) => boolean}    predicate   - Predicate testing whether a lease should be granted.
   * @param {(decision: TDecision) => LeaseDelta} leaseMapper - Mapper producing the `LeaseDelta` to grant.
   *
   * @returns {AskInterruptBuilder<TPayload, TDecision>} New immutable ask builder.
   */
  elevateLeaseWhen(
    predicate: (decision: TDecision) => boolean,
    leaseMapper: (decision: TDecision) => LeaseDelta,
  ): AskInterruptBuilder<TPayload, TDecision>;

  /**
   * Binds the synchronous formatter producing the feedback string returned to the interrupted actor on resumption.
   *
   * Required before `.toAST()` can compile a valid `AskInterruptHandlerNode`.
   *
   * @param {(decision: TDecision) => string} formatter - Resumption feedback formatter.
   *
   * @returns {AskInterruptBuilder<TPayload, TDecision>} New immutable ask builder.
   */
  resumeWith(
    formatter: (decision: TDecision) => string,
  ): AskInterruptBuilder<TPayload, TDecision>;
}

export type { AskInterruptBuilder as AskInterruptEdgeBuilder };
