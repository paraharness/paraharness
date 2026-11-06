/**
 * Outcome returned by `evaluateBeforeStopGate()` when an agent emits a completion turn (`SPEC.md` §3.4.1 & §3.7.1).
 *
 * Indicates whether all `beforeStop` checks, scoped rule checks, `conflictCleanCheck`, and open-fork gates passed.
 */
export interface BeforeStopGateEvaluationResult {
  /** True when all deterministic `beforeStop` checks passed with zero deficits. */
  readonly passed: boolean;
  /** Actionable deficit messages injected back into the transcript when `passed` is `false`. */
  readonly deficits: readonly string[];
  /** Identifiers of checks that failed during this gate evaluation. */
  readonly failedCheckIds: readonly string[];
}
