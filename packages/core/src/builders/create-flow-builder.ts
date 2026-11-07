import type { FlowBuilder } from './flow-builder.js';
import { createFlowFromState } from './internal/create-flow-from-state.js';
import { assertNonEmptyIdentifier } from './internal/deep-freeze.js';

/**
 * Creates a fluent `FlowBuilder` for `H.flow(id)`.
 *
 * Validates that `id` is a non-empty identifier and initializes an immutable
 * `FlowBuilder` with an empty step and branch node sequence.
 *
 * @param {string} id - Unique identifier of the flow.
 *
 * @returns {FlowBuilder<unknown, unknown, never, unknown, Record<string, unknown>, Record<string, never>>} Frozen `FlowBuilder` instance.
 */
export function createFlowBuilder(
  id: string,
): FlowBuilder<unknown, unknown, never, unknown, Record<string, unknown>, Record<string, never>> {
  assertNonEmptyIdentifier('H.flow', id);
  return createFlowFromState({
    id,
    nodes: [],
  });
}
