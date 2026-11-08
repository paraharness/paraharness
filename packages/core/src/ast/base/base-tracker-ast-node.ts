import type { BivariantCallback } from '../ast-foundation.types.js';

/**
 * Domain-agnostic base AST node contract for external work item trackers (`TrackerASTNode`).
 *
 * Resolved via `RuntimeExecutorRegistry.trackers[node.type]` into a `TrackerAdapter` polled
 * by `M.lane.tracker()`.
 *
 * @template TType          String-literal discriminant of the tracker node.
 * @template TExternal      Raw external issue or ticket record type returned by `poll()`.
 * @template TExternalState External tracker state string union accepted by `setExternalState()`.
 */
export interface BaseTrackerASTNode<
  TType extends string = string,
  TExternal = unknown,
  TExternalState extends string = string,
> {
  /** Unique string-literal discriminant of the tracker node. */
  readonly type: TType;
  /** Phantom type brand preserving the raw external ticket record type. */
  readonly __externalBrand?: BivariantCallback<[external: TExternal], void>;
  /** Phantom type brand preserving the external tracker state union. */
  readonly __stateBrand?: BivariantCallback<[state: TExternalState], void>;
}
