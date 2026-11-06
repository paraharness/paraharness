/**
 * Persisted run state returned by `LedgerStore.createOrResumeRun()`.
 *
 * Contains the current lifecycle status, active step ID, latest serialized flow input,
 * pinned wire prefixes, cumulative cost, and completed step outputs for `.inputFrom()` recovery.
 */
export interface CreateOrResumeRunResult {
  /** Current run lifecycle status (`'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED'` or terminal state). */
  readonly status: string;
  /** Identifier of the currently executing flow step, or `null`. */
  readonly currentStepId: string | null;
  /** Latest JSON-serialized flow input payload (reflecting any `.replaceWith()` or `.onSignal().update()` mutations). */
  readonly inputJson: string;
  /** Optional target `stepId` when a `.rewindTo()` signal is pending drain or prerequisite wakeup. */
  readonly rewindPendingToStepId?: string;
  /** Optional map of `prefixGroupId` to JSON-serialized `CompiledWirePrefix` pinned at run start. */
  readonly compiledPrefixesJson?: Readonly<Record<string, string>>;
  /** Cumulative USD cost recorded for the run. */
  readonly costUsd: number;
  /** Optional human-approved maximum USD budget ceiling. */
  readonly approvedMaxCostUsd?: number;
  /** Map of completed `stepId` (or outer `branchStepId`) to its JSON-serialized output for `.inputFrom()` recovery. */
  readonly completedStepOutputsJson: ReadonlyMap<string, string>;
}
