import type { ForkBatchEntryRecord } from '../../ports/fork-batch-continuation-frame.js';
import type { SuspendedForkRecord } from '../../ports/suspended-fork-record.js';
import type { ForkBatchExecutionParams } from './fork-batch-execution-params.js';

/**
 * Parameters for resuming a single `SuspendedForkRecord` via `resumeSuspendedForkEntry()`.
 *
 * Supplies the batch execution context, persisted `SuspendedForkRecord`, current `ForkBatchEntryRecord`,
 * resolution summary text, and entry persistence callback.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface ResumeSuspendedForkEntryParams<THandle = unknown> {
  /** Enclosing fork batch execution parameters. */
  readonly batchParams: ForkBatchExecutionParams<THandle>;
  /** Persisted `SuspendedForkRecord` being resumed. */
  readonly record: SuspendedForkRecord;
  /** Current `ForkBatchEntryRecord` in the `resumeFork` batch. */
  readonly entry: ForkBatchEntryRecord;
  /** Parent resolution summary text from `resumeFork`. */
  readonly resolutionSummary: string;
  /** Callback persisting an updated `ForkBatchEntryRecord` into `LedgerStore`. */
  readonly persistEntryUpdate: (updatedEntry: ForkBatchEntryRecord) => Promise<void>;
}
