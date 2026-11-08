import type { z } from 'zod';
import type { LessonRecord } from '../ports/lesson-record.js';
import type { BivariantCallback, SourceValue } from './ast-foundation.types.js';
import type { LessonStoreASTNode, ModelASTNode } from './domain-ast.types.js';
import type { PoolNode } from './pool-node.js';
import type { SignalNode } from './signal-node.js';

/**
 * Configuration for contrastive lesson distillation (`onLoopRecovery` and `onGateRecovery`).
 *
 * Specifies the distiller `model` and trigger thresholds for extracting reusable empirical
 * directives from failure-to-pass trajectory pairs.
 */
export interface LessonDistillationConfig {
  /** Model or model pool used by the contrastive distiller agent. */
  readonly model: ModelASTNode | PoolNode<ModelASTNode>;
  /** True when accepted iterations following a rejected `M.loop` evaluation trigger distillation. */
  readonly onLoopRecovery: boolean;
  /** Optional threshold configuring in-session `beforeStop` gate recovery distillation. */
  readonly onGateRecovery?: { readonly minFailedChecks: number };
  /** Optional distillation guidelines prompt or source. */
  readonly guidelines?: SourceValue<string>;
}

/**
 * Scoring and recall configuration for `M.lessons`.
 *
 * Governs sliding-window Bayesian score calculation, partition-affinity boosting, contract-epoch
 * decay, and top-$N$ recall filtering at session start.
 */
export interface LessonScoringConfig {
  /** Sliding window size $K$ of deduplicated step executions used in outcome scoring. */
  readonly slidingWindowInjections: number;
  /** Partition match boost factor $\beta$ applied when $L.\text{partition} \in P$. */
  readonly partitionMatchBoost: number;
  /** Exponential decay base $\gamma \in (0, 1]$ applied per partition contract epoch increment. */
  readonly decayOnPartitionEpochChange: number;
  /** Recall filter thresholds (`minScore` and `maxItems`). */
  readonly recall: { readonly minScore: number; readonly maxItems: number };
}

/**
 * Automatic retirement thresholds for low-performing or violated lessons.
 *
 * Archives a lesson immediately when lifetime violations reach `maxViolations` or when its
 * sliding-window clean-pass rate falls below `minCleanPassRate.minRate` after `afterInjections`.
 */
export interface LessonRetirementConfig {
  /** Optional maximum lifetime violation count $v$ before immediate retirement. */
  readonly maxViolations?: number;
  /** Optional minimum sliding-window clean-pass rate threshold after $m$ injections. */
  readonly minCleanPassRate?: { readonly minRate: number; readonly afterInjections: number };
}

/**
 * Signal emission trigger for promoting high-leverage lessons into permanent rules or checks.
 *
 * Emits `signal` with `mapPayload(lesson)` when a lesson accumulates at least `minCleanPasses`,
 * at most `maxViolations`, and has not triggered within the last `cooldownHours`.
 *
 * @template TPayload Emitted signal payload type.
 */
export interface LessonEmitSignalTrigger<TPayload = unknown> {
  /** Target `SignalNode` emitted when a lesson satisfies the promotion thresholds. */
  readonly signal: SignalNode<TPayload>;
  /** Minimum lifetime `clean_pass` count required to trigger emission. */
  readonly minCleanPasses: number;
  /** Maximum lifetime `violated` count allowed to trigger emission. */
  readonly maxViolations: number;
  /** Cooldown window in hours before re-emitting `signal` for the same lesson. */
  readonly cooldownHours: number;
  /** Pure synchronous mapper projecting a qualifying `LessonRecord` into the signal payload. */
  readonly mapPayload: BivariantCallback<[lesson: LessonRecord], TPayload>;
}

/**
 * Passive AST node representing an empirical lesson memory subsystem (`M.lessons(id)`).
 *
 * Combines a backing `LessonStoreASTNode` with query extraction, contrastive distillation,
 * sliding-window outcome scoring, automatic retirement, and promotion signal triggers.
 *
 * @template TIn Input payload type of actors querying this lesson store.
 */
export interface LessonsNode<TIn = unknown> {
  /** Discriminant identifying a lessons subsystem AST node. */
  readonly type: 'harness:lessons';
  /** Unique identifier of the lessons subsystem. */
  readonly id: string;
  /** Passive backing store AST node (`FsJsonlLessonStoreNode`, `SqliteLessonsNode`, or `PostgresLessonsNode`). */
  readonly store: LessonStoreASTNode;
  /** Optional Zod schema validating the input passed to `queryMapper`. */
  readonly querySchema?: z.ZodType<TIn>;
  /** Optional synchronous query extractor mapping actor input `TIn` to a search query string. */
  readonly queryMapper?: BivariantCallback<[input: TIn], string>;
  /** Optional contrastive distillation configuration. */
  readonly distillation?: LessonDistillationConfig;
  /** Scoring and recall parameters. */
  readonly scoring: LessonScoringConfig;
  /** Optional automatic retirement thresholds. */
  readonly retireAfter?: LessonRetirementConfig;
  /** Registered promotion signal triggers evaluated when lesson outcomes are recorded. */
  readonly emitSignalTriggers: readonly LessonEmitSignalTrigger[];
}
