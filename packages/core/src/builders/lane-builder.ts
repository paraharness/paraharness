import type { z } from 'zod';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { TrackerASTNode } from '../ast/domain-ast.types.js';
import type { FlowNode } from '../ast/flow-node.js';
import type { LaneNode } from '../ast/lane-node.js';
import type { ScopedHumanTargetNode } from '../ast/scoped-human-target-node.js';
import type { SignalNode } from '../ast/signal-node.js';
import type { BudgetApproval } from '../schemas/budget-and-lesson.schema.js';
import type {
  ExtractTrackerExternal,
  ExtractTrackerState,
} from './flow-extraction.types.js';
import type { LaneRetryBuilder } from './lane-retry-config-builder.js';
import type { LaneSignalHandlerBuilder } from './lane-signal-handler-builder.js';
import type { LaneTrackerBuilder } from './lane-tracker-config-builder.js';

export type {
  ExtractTrackerExternal,
  ExtractTrackerState,
} from './flow-extraction.types.js';
export type { LaneRetryBuilder } from './lane-retry-config-builder.js';
export type { LaneSignalHandlerBuilder } from './lane-signal-handler-builder.js';
export type { LaneTrackerBuilder } from './lane-tracker-config-builder.js';

/**
 * Fluent builder for a concurrent work execution lane (`H.lane(id)`).
 *
 * Configures work-item schema validation, deduplication keys, external tracker polling,
 * flow execution, concurrency and priority aging, prerequisites, cost ceilings, and signal rewinds.
 *
 * @template TIn      Validated lane work item input type.
 * @template TStepIds Union of literal step and branch IDs in the bound `FlowNode`.
 */
export interface LaneBuilder<TIn = unknown, TStepIds extends string = string>
  extends AstBuilder<LaneNode<TIn, TStepIds>> {
  /** Unique identifier of the lane. */
  readonly id: string;

  /**
   * Binds the Zod validation schema for work items entering the lane.
   *
   * Resets input-dependent `key`, `tracker`, `flow`, `waitFor`, and `onSignal` bindings when changed.
   *
   * @template TNewIn Validated lane work item input type.
   *
   * @param {z.ZodType<TNewIn, z.ZodTypeDef, unknown>} schema - Zod schema validating lane work items.
   *
   * @returns {LaneBuilder<TNewIn, TStepIds>} New immutable lane builder.
   */
  input<TNewIn>(
    schema: z.ZodType<TNewIn, z.ZodTypeDef, unknown>,
  ): LaneBuilder<TNewIn, TStepIds>;

  /**
   * Binds the synchronous extractor returning the unique deduplication key (`itemKey`) for each work item.
   *
   * Used by the lane scheduler to deduplicate inbound items and correlate prerequisite edges.
   *
   * @param {(input: TIn) => string} mapper - Item deduplication key extractor.
   *
   * @returns {LaneBuilder<TIn, TStepIds>} New immutable lane builder.
   */
  key(mapper: (input: TIn) => string): LaneBuilder<TIn, TStepIds>;

  /**
   * Configures external issue tracker polling and bidirectional state synchronization.
   *
   * Infers `ExtractTrackerExternal<TAdapter>` and `ExtractTrackerState<TAdapter>` from `adapter`.
   *
   * @template TAdapter Tracker AST node type.
   *
   * @param {MaybeBuilder<TAdapter>}                                                                                                                                                                     adapter   - Tracker adapter AST node or builder.
   * @param {($t: LaneTrackerBuilder<TIn, ExtractTrackerExternal<TAdapter>, ExtractTrackerState<TAdapter>>) => LaneTrackerBuilder<TIn, ExtractTrackerExternal<TAdapter>, ExtractTrackerState<TAdapter>>} configure - Tracker configurator callback.
   *
   * @returns {LaneBuilder<TIn, TStepIds>} New immutable lane builder.
   */
  tracker<TAdapter extends TrackerASTNode>(
    adapter: MaybeBuilder<TAdapter>,
    configure: (
      $t: LaneTrackerBuilder<
        TIn,
        ExtractTrackerExternal<TAdapter>,
        ExtractTrackerState<TAdapter>
      >,
    ) => LaneTrackerBuilder<TIn, ExtractTrackerExternal<TAdapter>, ExtractTrackerState<TAdapter>>,
  ): LaneBuilder<TIn, TStepIds>;

  /**
   * Binds the `FlowNode` executed for each work item in the lane.
   *
   * Narrows `TStepIds` to `TFlowStepIds` so `.onSignal(...).rewindTo(stepId)` is statically checked.
   *
   * @template TFlowStepIds Union of literal step and branch IDs in `flow`.
   *
   * @param {MaybeBuilder<FlowNode<TIn, unknown, TFlowStepIds>>} flow - Flow AST node or builder.
   *
   * @returns {LaneBuilder<TIn, TFlowStepIds>} New immutable lane builder narrowed to `TFlowStepIds`.
   */
  flow<TFlowStepIds extends string>(
    flow: MaybeBuilder<FlowNode<TIn, unknown, TFlowStepIds>>,
  ): LaneBuilder<TIn, TFlowStepIds>;

  /**
   * Alias for `.flow(flow)` binding the `FlowNode` executed for each work item in the lane.
   *
   * Narrows `TStepIds` to `TFlowStepIds` identically to `.flow(flow)`.
   *
   * @template TFlowStepIds Union of literal step and branch IDs in `flow`.
   *
   * @param {MaybeBuilder<FlowNode<TIn, unknown, TFlowStepIds>>} flow - Flow AST node or builder.
   *
   * @returns {LaneBuilder<TIn, TFlowStepIds>} New immutable lane builder narrowed to `TFlowStepIds`.
   */
  runs<TFlowStepIds extends string>(
    flow: MaybeBuilder<FlowNode<TIn, unknown, TFlowStepIds>>,
  ): LaneBuilder<TIn, TFlowStepIds>;

  /**
   * Sets the maximum number of concurrent runs executing in parallel within this lane.
   *
   * Throws immediately at builder call time if `limit < 1` or is not an integer.
   *
   * @param {number} limit - Positive integer concurrency limit.
   *
   * @returns {LaneBuilder<TIn, TStepIds>} New immutable lane builder.
   */
  concurrency(limit: number): LaneBuilder<TIn, TStepIds>;

  /**
   * Sets the base scheduling priority level (`'low' | 'normal' | 'high' | 'critical'`).
   *
   * Defaults to `'normal'` when not explicitly overridden.
   *
   * @param {'low' | 'normal' | 'high' | 'critical'} level - Base priority level.
   *
   * @returns {LaneBuilder<TIn, TStepIds>} New immutable lane builder.
   */
  priority(level: 'low' | 'normal' | 'high' | 'critical'): LaneBuilder<TIn, TStepIds>;

  /**
   * Sets the priority aging interval in minutes to prevent starvation of lower-priority items.
   *
   * Queued items waiting longer than multiples of `minutes` receive incremental priority boosts.
   *
   * @param {number} minutes - Positive priority aging interval in minutes.
   *
   * @returns {LaneBuilder<TIn, TStepIds>} New immutable lane builder.
   */
  agingMinutes(minutes: number): LaneBuilder<TIn, TStepIds>;

  /**
   * Configures prerequisite dependency extraction and the terminal fallback state when a dependency is abandoned.
   *
   * Holds queued items in `'waiting'` until all prerequisite keys returned by `depsMapper` exit `'done'`.
   *
   * @param {(input: TIn) => readonly string[]} depsMapper       - Prerequisite item key extractor.
   * @param {string}                            onAbandonedState - Terminal state when a prerequisite exits non-done.
   *
   * @returns {LaneBuilder<TIn, TStepIds>} New immutable lane builder.
   */
  waitFor(
    depsMapper: (input: TIn) => readonly string[],
    onAbandonedState: string,
  ): LaneBuilder<TIn, TStepIds>;

  /**
   * Configures a per-run USD cost limit and the scoped bidirectional human budget approver.
   *
   * Validates at builder call time that `approver` wraps a `'bidirectional'` human channel.
   *
   * @param {number}                                              limitUsd - Initial USD budget ceiling per run.
   * @param {MaybeBuilder<ScopedHumanTargetNode<BudgetApproval>>} approver - Scoped bidirectional human target.
   *
   * @returns {LaneBuilder<TIn, TStepIds>} New immutable lane builder.
   */
  maxCostUsd(
    limitUsd: number,
    approver: MaybeBuilder<ScopedHumanTargetNode<BudgetApproval>>,
  ): LaneBuilder<TIn, TStepIds>;

  /**
   * Configures step retry attempts and exponential backoff for the lane.
   *
   * Invokes `configure` with a `LaneRetryBuilder` and attaches the compiled `LaneRetryConfig`.
   *
   * @param {($r: LaneRetryBuilder) => LaneRetryBuilder} configure - Retry configurator callback.
   *
   * @returns {LaneBuilder<TIn, TStepIds>} New immutable lane builder.
   */
  retry(configure: ($r: LaneRetryBuilder) => LaneRetryBuilder): LaneBuilder<TIn, TStepIds>;

  /**
   * Registers a live signal steering and step rewind handler on the lane.
   *
   * Validates that the handler's `rewindToStepId` exists in `flow.nodes`.
   *
   * @template TPayload Signal payload type.
   *
   * @param {MaybeBuilder<SignalNode<TPayload>>}                                                                           signal    - Target `SignalNode` or builder.
   * @param {($s: LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>) => LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>} configure - Signal handler configurator callback.
   *
   * @returns {LaneBuilder<TIn, TStepIds>} New immutable lane builder.
   */
  onSignal<TPayload>(
    signal: MaybeBuilder<SignalNode<TPayload>>,
    configure: (
      $s: LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>,
    ) => LaneSignalHandlerBuilder<TIn, TStepIds, TPayload>,
  ): LaneBuilder<TIn, TStepIds>;
}
