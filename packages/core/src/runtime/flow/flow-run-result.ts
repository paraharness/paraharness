/**
 * Terminal outcome returned by `executeFlow()` (`SPEC.md` §3.9).
 *
 * Captures the terminal exit state, final scope receipt, completed step outputs, and folded
 * custom telemetry metrics.
 */
export interface FlowRunResult {
  /** Identifier of the flow run. */
  readonly runId: string;
  /** Terminal exit state string (`flow.exitState`, `'SUSPENDED'`, or failure state). */
  readonly exitState: string;
  /** Final scope receipt (`TReceipt`) inspected before releasing the root scope. */
  readonly scopeReceipt: Record<string, unknown>;
  /** Map of completed `stepId` (or outer `branchStepId`) to its validated output value. */
  readonly stepOutputs: Readonly<Record<string, unknown>>;
  /** Custom telemetry metrics folded by `flow.telemetry`, if configured. */
  readonly customTelemetry?: Readonly<Record<string, unknown>>;
}
