import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { ScopeRewindHookASTNode } from '../ast/domain-ast.types.js';
import type { LaneSignalHandlerConfig } from '../ast/lane-node.js';

/**
 * Fluent sub-builder for live signal steering and step rewind (`lane.onSignal(sig, $ => ...)`).
 *
 * Configures the synchronous work-item input reducer (`.update(mapper)`) and the
 * type-checked target step or branch ID in the bound flow (`.rewindTo(stepId, options)`).
 *
 * @template TIn      Validated lane work item input type.
 * @template TStepIds Union of literal step and branch IDs in the lane's flow.
 * @template TPayload Signal payload type.
 */
export interface LaneSignalHandlerBuilder<
  TIn = unknown,
  TStepIds extends string = string,
  TPayload = unknown,
> {
  /**
   * Binds the synchronous reducer updating the active run's input from `(currentInput, signalPayload)`.
   *
   * Required before `.toAST()` can compile a valid `LaneSignalHandlerConfig`.
   *
   * @param {(current: TIn, payload: TPayload) => TIn} mapper - Input update reducer.
   *
   * @returns {LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>} New immutable signal handler builder.
   */
  update(
    mapper: (current: TIn, payload: TPayload) => TIn,
  ): LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>;

  /**
   * Constrains and sets the target step or branch ID in `flow.nodes` to rewind execution to.
   *
   * Optionally binds a `ScopeRewindHookASTNode` executed when rewinding a Tier-1 `'scope'`.
   *
   * @param {TStepIds}                                                              stepId    - Literal step or branch ID in the bound `FlowNode`.
   * @param {{ readonly onRewind?: MaybeBuilder<ScopeRewindHookASTNode<unknown>> }} [options] - Optional scope rewind hook.
   *
   * @returns {LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>} New immutable signal handler builder.
   */
  rewindTo(
    stepId: TStepIds,
    options?: { readonly onRewind?: MaybeBuilder<ScopeRewindHookASTNode<unknown>> },
  ): LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>;

  /**
   * Compiles the signal handler configuration into a frozen `LaneSignalHandlerConfig`.
   *
   * Throws at builder compilation time if either `.update(mapper)` or `.rewindTo(stepId)` is missing.
   *
   * @returns {LaneSignalHandlerConfig<TIn, TStepIds, TPayload>} Deeply frozen lane signal handler configuration.
   */
  toAST(): LaneSignalHandlerConfig<TIn, TStepIds, TPayload>;
}
