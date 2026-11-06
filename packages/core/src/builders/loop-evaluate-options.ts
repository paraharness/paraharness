import type { ExtractEvalScopeReceipt } from './flow-extraction.types.js';

/**
 * Configuration options passed to `LoopBuilder.evaluate(stepId, evaluator, options)`.
 *
 * Defines the synchronous evaluator input mapper, acceptance predicate, and rejection
 * feedback formatter for an `H.loop(id)` refinement cycle.
 *
 * @template TIn      Loop input payload type.
 * @template TOut     Action step output payload type.
 * @template TEvalIn  Evaluator agent input payload type.
 * @template TEvalOut Evaluator agent output payload type.
 * @template TReceipt Inspected scope receipt type.
 */
export interface LoopEvaluateOptions<
  TIn = unknown,
  TOut = unknown,
  TEvalIn = unknown,
  TEvalOut = unknown,
  TReceipt = ExtractEvalScopeReceipt<TEvalIn>,
> {
  /** Synchronous mapper constructing the evaluator's input from `(loopInput, actOutput, scopeReceipt)`. */
  readonly mapInput: (loopInput: TIn, actOutput: TOut, scopeReceipt: TReceipt) => TEvalIn;
  /** Predicate returning `true` when the evaluator accepts the action step's output. */
  readonly acceptWhen: (evalOut: TEvalOut) => boolean;
  /** Synchronous formatter producing the rejection feedback string injected into the next `.act()` iteration. */
  readonly feedbackMapper: (evalOut: TEvalOut) => string;
}
