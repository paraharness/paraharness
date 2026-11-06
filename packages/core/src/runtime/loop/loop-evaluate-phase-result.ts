/**
 * Outcome returned by `runLoopEvaluatePhase()` after executing the evaluator agent on an `.act()` output (`SPEC.md` §3.8).
 *
 * Indicates whether the iteration was accepted (`accepted: true`) or rejected with feedback (`accepted: false`).
 *
 * @template TOut Validated `.act()` and loop output payload type.
 */
export interface LoopEvaluatePhaseResult<TOut = unknown> {
  /** True when `evaluateStep.acceptWhen(evalOut)` returned `true`. */
  readonly accepted: boolean;
  /** Validated `.act()` output accepted or rejected in this iteration. */
  readonly actOutput: TOut;
  /** Rejection feedback string produced by `evaluateStep.feedbackMapper(evalOut)` when `accepted` is `false`. */
  readonly feedback?: string;
  /** Raw evaluator output payload. */
  readonly evaluatorOutput: unknown;
}
