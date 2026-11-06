import type { LaneTrackerConfig } from '../ast/lane-node.js';

/**
 * Fluent sub-builder for external issue tracker polling and state synchronization (`lane.tracker(adapter, $ => ...)`).
 *
 * Configures polling cadence, external issue-to-work-item projection, and bidirectional
 * lifecycle state mappings (`onQueued`, `onRunning`, `onWaiting`, `onErrored`, `onCancelled`, `onExit`).
 *
 * @template TIn            Validated lane work item input type.
 * @template TExternal      Raw external issue payload type from the tracker adapter.
 * @template TExternalState External tracker state string type.
 */
export interface LaneTrackerConfigBuilder<
  TIn = unknown,
  TExternal = unknown,
  TExternalState extends string = string,
> {
  /**
   * Sets the polling interval in seconds for querying the external issue tracker.
   *
   * Defaults to `60` seconds when `.everySeconds(...)` is not explicitly called.
   *
   * @param {number} seconds - Positive polling interval in seconds.
   *
   * @returns {LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>} New immutable tracker builder.
   */
  everySeconds(seconds: number): LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>;

  /**
   * Binds the synchronous mapper projecting an external issue into `TIn` (or `undefined` to skip).
   *
   * Required before `.toAST()` can compile a valid `LaneTrackerConfig`.
   *
   * @param {(external: TExternal) => TIn | undefined} mapper - External issue projector callback.
   *
   * @returns {LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>} New immutable tracker builder.
   */
  from(
    mapper: (external: TExternal) => TIn | undefined,
  ): LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>;

  /**
   * Maps the internal `'queued'` lane state to `externalState`.
   *
   * Synchronizes the external tracker issue state whenever a work item is queued.
   *
   * @param {TExternalState} externalState - Target external tracker state.
   *
   * @returns {LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>} New immutable tracker builder.
   */
  onQueued(externalState: TExternalState): LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>;

  /**
   * Maps the internal `'running'` lane state to `externalState`.
   *
   * Synchronizes the external tracker issue state whenever a work item acquires a concurrency slot.
   *
   * @param {TExternalState} externalState - Target external tracker state.
   *
   * @returns {LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>} New immutable tracker builder.
   */
  onRunning(externalState: TExternalState): LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>;

  /**
   * Maps the internal `'waiting'` lane state to `externalState`.
   *
   * Synchronizes the external tracker issue state when a run suspends on a human decision or prerequisite.
   *
   * @param {TExternalState} externalState - Target external tracker state.
   *
   * @returns {LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>} New immutable tracker builder.
   */
  onWaiting(externalState: TExternalState): LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>;

  /**
   * Maps the internal `'errored'` lane state to `externalState`.
   *
   * Synchronizes the external tracker issue state when a run fails after exhausting retries.
   *
   * @param {TExternalState} externalState - Target external tracker state.
   *
   * @returns {LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>} New immutable tracker builder.
   */
  onErrored(externalState: TExternalState): LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>;

  /**
   * Maps the internal `'cancelled'` lane state to `externalState`.
   *
   * Synchronizes the external tracker issue state when a run is explicitly cancelled.
   *
   * @param {TExternalState} externalState - Target external tracker state.
   *
   * @returns {LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>} New immutable tracker builder.
   */
  onCancelled(externalState: TExternalState): LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>;

  /**
   * Maps a terminal flow exit state (`'exit:${exitState}'`) to `externalState`.
   *
   * Synchronizes the external tracker issue state when the bound flow exits with `exitState`.
   *
   * @param {string}         exitState     - Internal terminal exit state label (e.g. `'done'`).
   * @param {TExternalState} externalState - Target external tracker state.
   *
   * @returns {LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>} New immutable tracker builder.
   */
  onExit(
    exitState: string,
    externalState: TExternalState,
  ): LaneTrackerConfigBuilder<TIn, TExternal, TExternalState>;

  /**
   * Compiles the tracker configuration into a frozen `LaneTrackerConfig<TIn, TExternal>`.
   *
   * Throws at builder compilation time if `.from(mapper)` has not been configured.
   *
   * @returns {LaneTrackerConfig<TIn, TExternal>} Deeply frozen lane tracker configuration.
   */
  toAST(): LaneTrackerConfig<TIn, TExternal>;
}

export type { LaneTrackerConfigBuilder as LaneTrackerBuilder };
