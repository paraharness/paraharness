/**
 * Optional retry and timestamp parameters supplied to `PoolManager.selectModel()` (`SPEC.md` §3.2).
 *
 * Controls retry tier escalation and deterministic wall-clock evaluation for rate-limit windows.
 */
export interface PoolModelSelectionOptions {
  /** Zero-based retry attempt index for `'escalate-on-retry'` pools. */
  readonly retryAttempt?: number;
  /** Optional current epoch timestamp in milliseconds (defaults to `Date.now()`). */
  readonly nowMs?: number;
}
