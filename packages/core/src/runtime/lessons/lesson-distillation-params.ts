import type { LessonsNode } from '../../ast/lessons-node.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { PoolManager } from '../pools/pool-manager.js';

/**
 * Rejected-to-accepted trajectory pair supplied to contrastive lesson distillation (`SPEC.md` §3.4.3).
 *
 * Captures the source (`'loop'` vs `'gate'`), rejected attempt output/receipt/deficits, and
 * subsequent accepted attempt output/receipt.
 */
export interface ContrastiveDistillationTrajectoryPair {
  /** Origin of the recovery trajectory (`'loop'` for outer loop recovery, `'gate'` for `beforeStop` recovery). */
  readonly source: 'loop' | 'gate';
  /** Snapshot of the rejected iteration or failed `beforeStop` gate attempt. */
  readonly rejected: {
    readonly output: unknown;
    readonly scopeReceipt?: Record<string, unknown>;
    readonly failedChecks?: readonly string[];
    readonly deficits: readonly string[];
  };
  /** Snapshot of the accepted iteration or passing `beforeStop` gate attempt. */
  readonly accepted: {
    readonly output: unknown;
    readonly scopeReceipt?: Record<string, unknown>;
  };
}

/**
 * Parameters for executing contrastive lesson distillation (`runContrastiveLessonDistillation`).
 *
 * Supplies the `LessonsNode`, `LessonStore`, optional `TopologyStore`, trajectory pair,
 * step execution context, and optional `PoolManager`.
 */
export interface LessonDistillationParams {
  /** Passive `LessonsNode` containing `distillation` configuration. */
  readonly lessonsNode: LessonsNode<unknown>;
  /** Backing `LessonStore` into which admitted lessons are written. */
  readonly lessonStore: LessonStore;
  /** Optional `TopologyStore` queried for active overlay `epoch` and `lastMutatedByRunId`. */
  readonly topologyStore?: TopologyStore;
  /** Failure-to-pass trajectory pair (`'loop'` or `'gate'`). */
  readonly trajectory: ContrastiveDistillationTrajectoryPair;
  /** Step execution context providing `runId`, `registry`, and environment resolution. */
  readonly ctx: StepExecutionContext<unknown>;
  /** Optional `PoolManager` used when `distillation.model` is a `PoolNode`. */
  readonly poolManager?: PoolManager;
}
