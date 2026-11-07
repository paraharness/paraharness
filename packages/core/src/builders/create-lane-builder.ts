import { createLaneFromState } from './internal/create-lane-from-state.js';
import { assertNonEmptyIdentifier } from './internal/deep-freeze.js';
import type { LaneBuilder } from './lane-builder.js';

/**
 * Creates a fluent `LaneBuilder` for `H.lane(id)`.
 *
 * Validates that `id` is a non-empty identifier and initializes an immutable
 * `LaneBuilder` with default `concurrency: 1` and `priority: 'normal'`.
 *
 * @param {string} id - Unique identifier of the lane.
 *
 * @returns {LaneBuilder<unknown, string>} Frozen `LaneBuilder` instance.
 */
export function createLaneBuilder(id: string): LaneBuilder<unknown, string> {
  assertNonEmptyIdentifier('H.lane', id);
  return createLaneFromState({
    id,
    concurrency: 1,
    priority: 'normal',
    onSignalHandlers: [],
  });
}
