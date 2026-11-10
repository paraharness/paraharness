import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { LaneNode } from '../ast/lane-node.js';
import type { SignalNode } from '../ast/signal-node.js';
import type { ActiveRunSummary } from './active-run-summary.js';

/**
 * Programmatic control surface exposed to control-plane adapters and host processes for interacting with a live runtime.
 *
 * Supports emitting typed external signals into active runs, enqueuing work items onto lanes, and querying in-flight run summaries.
 */
export interface HarnessRuntimeController {
  /**
   * Emits an external signal payload to all lanes and runs correlated with `signal`.
   *
   * Validates `payload` against the target `SignalNode` schema and routes the event to matching
   * harness notification handlers, topology overlay commit hooks, ledger compaction triggers, and lane rewind handlers.
   *
   * @template TPayload Validated signal payload type.
   *
   * @param {MaybeBuilder<SignalNode<TPayload>> | string} signal  - `P.signal(...)` builder, `SignalNode`, or string signal identifier to trigger.
   * @param {TPayload}                                    payload - Signal payload to validate and route.
   *
   * @returns {Promise<void>} Resolves once the signal has been routed and processed.
   */
  emitSignal<TPayload>(
    signal: MaybeBuilder<SignalNode<TPayload>> | string,
    payload: TPayload,
  ): Promise<void>;

  /**
   * Validates `item` against the target lane's `inputSchema`, enqueues it on `lane`, and schedules ready runs (`SPEC.md` §2.8 & §3.10).
   *
   * Accepts a `P.lane(...)` builder, a compiled `LaneNode`, or a string lane identifier registered on the harness.
   *
   * @template TIn Validated lane work item input type.
   *
   * @param {MaybeBuilder<LaneNode<TIn, string>> | string} lane - Target lane builder, AST node, or lane identifier.
   * @param {TIn}                                          item - Work item payload to validate and enqueue.
   *
   * @returns {Promise<void>} Resolves once the item is enqueued and any ready runs in the lane have settled.
   *
   * @throws {Error} If `lane` is not registered on the enclosing `HarnessNode` or `item` fails `lane.inputSchema`.
   */
  enqueue<TIn = unknown>(
    lane: MaybeBuilder<LaneNode<TIn, string>> | string,
    item: TIn,
  ): Promise<void>;

  /**
   * Returns a snapshot of all currently queued, running, or suspended runs across all lanes.
   *
   * Queries the active scheduler and ledger state without mutating in-flight execution.
   *
   * @returns {Promise<ReadonlyArray<ActiveRunSummary>>} Active run summaries.
   */
  getActiveRuns(): Promise<ReadonlyArray<ActiveRunSummary>>;
}
