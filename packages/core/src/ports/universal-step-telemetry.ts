/**
 * Universal step execution telemetry record passed to `.replaceWith()` mappers and persisted in `LedgerStore`.
 *
 * Aggregates turn count, USD cost, wall-clock duration, domain-specific `custom` metrics from
 * `TelemetryCollectorASTNode`, and optional `abortMeta` from `AbortHookASTNode`.
 *
 * @template TCustomMetrics Domain-specific custom telemetry metrics record shape.
 * @template TAbortMeta     Optional abort hook metadata record shape.
 */
export interface UniversalStepTelemetry<
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Cumulative number of LLM turns taken during the step execution. */
  readonly turnsTaken: number;
  /** Cumulative model invocation cost in USD for the step execution. */
  readonly costUsd: number;
  /** Cumulative elapsed execution duration in milliseconds. */
  readonly durationMs: number;
  /** Domain-specific telemetry metrics collected from `observedEffects`. */
  readonly custom: TCustomMetrics;
  /** Optional metadata returned by the step's `AbortHookASTNode` upon step replacement. */
  readonly abortMeta?: TAbortMeta;
}
