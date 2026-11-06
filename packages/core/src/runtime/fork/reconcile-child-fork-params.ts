import type { StepASTNode } from '../../ast/domain-ast.types.js';
import type { ForkBatchEntryRecord } from '../../ports/fork-batch-continuation-frame.js';
import type { ChildForkExecutionOutcome } from './child-fork-execution-outcome.js';
import type { ForkBatchExecutionParams } from './fork-batch-execution-params.js';

/**
 * Parameters for reconciling a completed child fork via 3-way `commitChild` with conflict-bounce retries.
 *
 * Supplies the batch execution context, child entry, isolated `childHandle`, child AST node, and outcome.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface ReconcileChildForkParams<THandle = unknown> {
  /** Enclosing fork batch execution parameters. */
  readonly batchParams: ForkBatchExecutionParams<THandle>;
  /** Current `ForkBatchEntryRecord` for the child fork. */
  readonly entry: ForkBatchEntryRecord;
  /** Isolated child scope handle. */
  readonly childHandle: THandle;
  /** Child `AgentNode` or `LoopNode` executable. */
  readonly childNode: StepASTNode<unknown, unknown, THandle>;
  /** Validated child input payload. */
  readonly childInput: unknown;
  /** Completed child execution outcome. */
  readonly outcome: ChildForkExecutionOutcome<unknown>;
  /** Callback persisting an updated `ForkBatchEntryRecord` into `LedgerStore`. */
  readonly persistEntryUpdate: (updatedEntry: ForkBatchEntryRecord) => Promise<void>;
}
