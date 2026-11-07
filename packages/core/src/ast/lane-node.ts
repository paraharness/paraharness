import type { z } from 'zod';
import type { BudgetApproval } from '../schemas/budget-and-lesson.schema.js';
import type { BivariantCallback } from './ast-foundation.types.js';
import type { ScopeRewindHookASTNode, TrackerASTNode } from './domain-ast.types.js';
import type { FlowNode } from './flow-node.js';
import type { ScopedHumanTargetNode } from './scoped-human-target-node.js';
import type { SignalNode } from './signal-node.js';

/**
 * External issue tracker polling and state mapping configuration for a `LaneNode`.
 *
 * Polls `adapter` every `everySeconds`, projects external issues into `TIn` via `fromIssue`,
 * and mirrors internal lane run states back to external tracker states via `stateMappings`.
 *
 * @template TIn       Validated lane work item input type.
 * @template TExternal Raw external issue payload type from the tracker adapter.
 */
export interface LaneTrackerConfig<TIn = unknown, TExternal = unknown> {
  /** Passive tracker adapter AST node (`GithubIssuesTrackerNode` or custom tracker). */
  readonly adapter: TrackerASTNode<TExternal, string>;
  /** Polling interval in seconds. */
  readonly everySeconds: number;
  /** Synchronous mapper projecting an external issue into `TIn` (or `undefined` to skip). */
  readonly fromIssue: BivariantCallback<[external: TExternal], TIn | undefined>;
  /** Canonical mapping of internal lane lifecycle states (`'queued'`, `'running'`, `'waiting'`, `'errored'`, `'cancelled'`, `'exit:<state>'`) to external tracker states. */
  readonly stateMappings: Readonly<Record<string, string>>;
}

/**
 * Prerequisite dependency extraction and abandoned-dependency fallback configuration for a `LaneNode`.
 *
 * Holds a queued work item in `'waiting'` until every prerequisite item key returned by `depsMapper(input)`
 * exits in `'done'`, or transitions to `onAbandonedState` if any prerequisite fails or is cancelled.
 *
 * @template TIn Validated lane work item input type.
 */
export interface LaneWaitForConfig<TIn = unknown> {
  /** Synchronous extractor returning prerequisite item keys that must exit `'done'` before this item starts. */
  readonly depsMapper: BivariantCallback<[input: TIn], readonly string[]>;
  /** Terminal state assigned to a waiting run if one of its prerequisites exits in a non-success state. */
  readonly onAbandonedState: string;
}

/**
 * Per-run USD budget ceiling and human approval target for a `LaneNode`.
 *
 * Suspends an active run when cumulative model cost reaches `limitUsd` and pages `approver`
 * for a `BudgetApproval` decision to either raise the limit or terminate the run.
 */
export interface LaneMaxCostConfig {
  /** Initial maximum cumulative USD cost allowed per run before requesting human budget approval. */
  readonly limitUsd: number;
  /** Scoped bidirectional human target validating responses against `BudgetApprovalSchema`. */
  readonly approver: ScopedHumanTargetNode<BudgetApproval>;
}

/**
 * Step retry and exponential backoff configuration for a `LaneNode`.
 *
 * Retries transient step failures up to `tries` times with exponential backoff starting at
 * `exponentialBaseMs` before terminating the run in `orFailState`.
 */
export interface LaneRetryConfig {
  /** Maximum number of execution attempts per step before failing the run. */
  readonly tries: number;
  /** Base delay in milliseconds for exponential retry backoff. */
  readonly exponentialBaseMs: number;
  /** Terminal state recorded when all retry attempts are exhausted. */
  readonly orFailState: string;
}

/**
 * Live signal steering and step rewind handler configuration for a `LaneNode`.
 *
 * Executes the Hierarchical Rewind Drain Barrier when `signal` correlates to an active run,
 * reduces the run input via `updateMapper`, runs `onRewind`, and rewinds execution to `rewindToStepId`.
 *
 * @template TIn      Validated lane work item input type.
 * @template TStepIds Union of literal step and branch IDs in the lane's flow.
 * @template TPayload Signal payload type.
 */
export interface LaneSignalHandlerConfig<
  TIn = unknown,
  TStepIds extends string = string,
  TPayload = unknown,
> {
  /** External `SignalNode` triggering this handler. */
  readonly signal: SignalNode<TPayload>;
  /** Synchronous reducer updating the active run's input from `(currentInput, signalPayload)`. */
  readonly updateMapper: BivariantCallback<[current: TIn, payload: TPayload], TIn>;
  /** Literal target step or branch ID in `flow.nodes` to rewind execution to. */
  readonly rewindToStepId: TStepIds;
  /** Optional scope rewind hook executed during Step 4 of the Hierarchical Rewind Drain Barrier. */
  readonly onRewind?: ScopeRewindHookASTNode<unknown>;
}

/**
 * Passive AST node representing a concurrent work execution lane (`H.lane(id)`).
 *
 * Schedules deduplicated work items through `flow` under priority aging, prerequisite DAG barriers,
 * USD budget ceilings, step retry policies, and live signal rewind handlers.
 *
 * @template TIn      Validated lane work item input type.
 * @template TStepIds Union of literal step and branch IDs in the bound `FlowNode`.
 */
export interface LaneNode<TIn = unknown, TStepIds extends string = string> {
  /** Discriminant identifying a work execution lane AST node. */
  readonly type: 'harness:lane';
  /** Unique identifier of the lane. */
  readonly id: string;
  /** Zod schema validating work items entering the lane. */
  readonly inputSchema: z.ZodType<TIn>;
  /** Synchronous extractor returning the unique deduplication key (`itemKey`) for each work item. */
  readonly keyMapper: BivariantCallback<[input: TIn], string>;
  /** Optional external issue tracker configuration. */
  readonly tracker?: LaneTrackerConfig<TIn>;
  /** Compiled `FlowNode` executed for each work item in the lane. */
  readonly flow: FlowNode<TIn, unknown, TStepIds>;
  /** Maximum number of concurrent runs executing in parallel within this lane. */
  readonly concurrency: number;
  /** Base scheduling priority level (`'low' | 'normal' | 'high' | 'critical'`). */
  readonly priority: 'low' | 'normal' | 'high' | 'critical';
  /** Optional priority aging interval in minutes to prevent starvation of lower-priority items. */
  readonly agingMinutes?: number;
  /** Optional prerequisite dependency extractor and failure state configuration. */
  readonly waitFor?: LaneWaitForConfig<TIn>;
  /** Optional per-run USD cost limit and human budget approver. */
  readonly maxCostUsd?: LaneMaxCostConfig;
  /** Optional step retry and exponential backoff policy. */
  readonly retry?: LaneRetryConfig;
  /** Registered live signal steering and step rewind handlers. */
  readonly onSignalHandlers: readonly LaneSignalHandlerConfig<TIn, TStepIds>[];
}
