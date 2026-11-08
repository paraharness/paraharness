/**
 * Runtime adapter port for external issue or ticket trackers (`@metaharness/github`).
 *
 * Resolved from `TrackerASTNode` via `RuntimeExecutorRegistry.trackers[node.type]`.
 *
 * @template TExternal      Raw external issue or ticket record type.
 * @template TExternalState External tracker state string union.
 */
export interface TrackerAdapter<TExternal = unknown, TExternalState extends string = string> {
  /**
   * Polls the external tracker for candidate work items.
   *
   * Invoked periodically by the lane scheduler according to `LaneNode.tracker.pollIntervalSeconds`.
   *
   * @returns {Promise<readonly TExternal[]>} Raw external issue records.
   */
  poll(): Promise<readonly TExternal[]>;

  /**
   * Transitions `itemKey` to `state` in the external tracker.
   *
   * Synchronizes the external issue or ticket status when a lane item changes lifecycle state.
   *
   * @param {string}         itemKey - Work item key extracted by `LaneNode.keyMapper`.
   * @param {TExternalState} state   - Mapped external state string from `LaneNode.tracker.stateMappings`.
   *
   * @returns {Promise<void>} Resolves once the external tracker state is updated.
   */
  setExternalState(itemKey: string, state: TExternalState): Promise<void>;
}
