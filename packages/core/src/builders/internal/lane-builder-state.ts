import type { z } from 'zod';
import type { BivariantCallback } from '../../ast/ast-foundation.types.js';
import type { FlowNode } from '../../ast/flow-node.js';
import type {
  LaneMaxCostConfig,
  LaneRetryConfig,
  LaneSignalHandlerConfig,
  LaneTrackerConfig,
  LaneWaitForConfig,
} from '../../ast/lane-node.js';

/**
 * Immutable copy-on-write state snapshot backing `LaneBuilder`.
 *
 * Accumulates work item input validation, deduplication key extraction, issue tracker
 * synchronization, flow binding, scheduling priority, budget gates, retries, and signal handlers.
 *
 * @template TIn      Validated lane work item input payload type.
 * @template TStepIds Union of literal step and branch identifiers in the bound `FlowNode`.
 */
export interface LaneBuilderState<TIn = unknown, TStepIds extends string = string> {
  /** Unique lane identifier passed to `P.lane(id)`. */
  readonly id: string;
  /** Zod schema validating work items entering the lane. */
  readonly inputSchema?: z.ZodType<TIn>;
  /** Synchronous extractor returning the deduplication `itemKey` for each work item. */
  readonly keyMapper?: BivariantCallback<[input: TIn], string>;
  /** Optional external issue tracker polling and state mapping configuration. */
  readonly tracker?: LaneTrackerConfig<TIn>;
  /** Bound workflow AST node executed for each work item. */
  readonly flow?: FlowNode<TIn, unknown, TStepIds>;
  /** Maximum number of concurrent runs executing in parallel within this lane. */
  readonly concurrency: number;
  /** Base scheduling priority level for work items in this lane. */
  readonly priority: 'low' | 'normal' | 'high' | 'critical';
  /** Optional priority aging interval in minutes to prevent lower-priority starvation. */
  readonly agingMinutes?: number;
  /** Optional prerequisite dependency extractor and abandoned-dependency fallback state. */
  readonly waitFor?: LaneWaitForConfig<TIn>;
  /** Optional per-run USD cost ceiling and bidirectional human budget approver. */
  readonly maxCostUsd?: LaneMaxCostConfig;
  /** Optional step retry count and exponential backoff configuration. */
  readonly retry?: LaneRetryConfig;
  /** Live signal steering and step rewind handlers registered on this lane. */
  readonly onSignalHandlers: readonly LaneSignalHandlerConfig<TIn, TStepIds>[];
}
