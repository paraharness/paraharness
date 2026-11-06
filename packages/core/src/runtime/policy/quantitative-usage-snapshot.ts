/**
 * Quantitative turn, cost, and duration counters checked against `PolicyNode` ceilings.
 *
 * In `H.loop`, populated from `.act()`-only counters (`actTurnsTaken`, `actCostUsd`, `actElapsedDurationMs`).
 */
export interface QuantitativeUsageSnapshot {
  /** Number of LLM turns taken so far. */
  readonly turnsTaken: number;
  /** Cumulative USD cost incurred so far. */
  readonly costUsd: number;
  /** Cumulative elapsed duration in milliseconds so far. */
  readonly elapsedDurationMs: number;
}
