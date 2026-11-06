import type { LessonsNode } from '../../ast/lessons-node.js';
import type { LessonOutcome } from '../../ports/lesson-outcome.types.js';
import type { LessonRecord } from '../../ports/lesson-record.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { PoolManager } from '../pools/pool-manager.js';

/**
 * Partition epoch and run attribution resolved for a newly distilled lesson (`SPEC.md` §3.4.3).
 *
 * Supplies `epochAtCreation` and `createdByRunId` from the active `TopologyStore` run overlay.
 */
export interface LessonCreationEpochMetadata {
  /** Partition contract epoch active when the lesson was created. */
  readonly epochAtCreation: number;
  /** Run identifier that last mutated the partition overlay, or the current `runId`. */
  readonly createdByRunId: string | undefined;
}

/**
 * Optional partition and epoch context passed to `computeLessonScore()` and `selectRecalledLessons()`.
 *
 * Supplies the active task partitions and live partition contract epochs without exceeding
 * three positional parameters on scoring functions.
 */
export interface LessonScoreContextParams {
  /** Active logical partitions unlocked for the current actor or loop. */
  readonly activePartitions?: readonly string[];
  /** Explicit current epoch $E_{\text{now}}$ for `lesson.partition`. */
  readonly currentPartitionEpoch?: number;
  /** Map of `partitionId` to current epoch $E_{\text{now}}$ loaded from `TopologyStore`. */
  readonly partitionEpochs?: ReadonlyMap<string, number>;
}

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
 * Parameters for evaluating `.emitSignalWhen()` triggers on updated `LessonRecord` entries.
 *
 * Supplies the `LessonsNode`, backing `LessonStore`, updated lesson records, signal emitter,
 * and optional deterministic timestamp override.
 */
export interface EvaluateLessonSignalTriggersParams {
  /** Passive `LessonsNode` declaring `emitSignalTriggers`. */
  readonly lessonsNode: LessonsNode<unknown>;
  /** Runtime `LessonStore` persisting `markSignalEmitted` timestamps. */
  readonly lessonStore: LessonStore;
  /** Updated `LessonRecord` instances returned by `LessonStore.recordOutcomes()`. */
  readonly updatedLessons: readonly LessonRecord[];
  /** Callback routing emitted promotion signals into the harness controller. */
  readonly emitSignal?: <TPayload>(signalId: string, payload: TPayload) => Promise<void>;
  /** Optional ISO-8601 timestamp override for deterministic cooldown testing. */
  readonly nowIso?: string;
}

/**
 * Parameters for flushing deduplicated step or loop lesson outcomes to `LessonStore`.
 *
 * Consolidates the `LessonsNode`, `LessonStore`, deduplicated outcome map, retirement evaluation,
 * and promotion signal routing.
 */
export interface FlushStepLessonOutcomesParams {
  /** Passive `LessonsNode` governing scoring, retirement, and promotion signals. */
  readonly lessonsNode: LessonsNode<unknown>;
  /** Runtime `LessonStore` receiving `recordOutcomes` and `retire` calls. */
  readonly lessonStore: LessonStore;
  /** Deduplicated `lessonId -> LessonOutcome` map accumulated across the step or loop. */
  readonly accumulatedOutcomes: Readonly<Record<string, LessonOutcome>>;
  /** Optional callback routing emitted promotion signals into the harness controller. */
  readonly emitSignal?: <TPayload>(signalId: string, payload: TPayload) => Promise<void>;
  /** Optional ISO-8601 timestamp override for deterministic cooldown testing. */
  readonly nowIso?: string;
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
  /** Optional reference to score context parameters for property reachability. */
  readonly scoreContextTemplate?: LessonScoreContextParams;
  /** Optional reference to flush parameters for property reachability. */
  readonly flushTemplate?: FlushStepLessonOutcomesParams;
  /** Optional reference to signal trigger parameters for property reachability. */
  readonly signalTriggerTemplate?: EvaluateLessonSignalTriggersParams;
  /** Optional reference to creation epoch metadata for property reachability. */
  readonly creationEpochTemplate?: LessonCreationEpochMetadata;
}
