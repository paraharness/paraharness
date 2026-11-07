import { createLoopFromState } from './internal/create-loop-from-state.js';
import { assertNonEmptyIdentifier } from './internal/deep-freeze.js';
import type { LoopBuilder } from './loop-builder.js';

/**
 * Creates a fluent `LoopBuilder` for `H.loop(id)`.
 *
 * Validates that `id` is a non-empty identifier and initializes an immutable
 * `LoopBuilder` with `maxIterations: 3` and `preserveActorSession: true`.
 *
 * @template THandle Isolation scope handle type.
 *
 * @param {string} id - Unique identifier of the loop definition.
 *
 * @returns {LoopBuilder<unknown, unknown, THandle, string>} Frozen `LoopBuilder` instance.
 */
export function createLoopBuilder<THandle = unknown>(
  id: string,
): LoopBuilder<unknown, unknown, THandle, string> {
  assertNonEmptyIdentifier('H.loop', id);
  return createLoopFromState<unknown, unknown, THandle, string>({
    id,
    roleKey: id,
    maxIterations: 3,
    preserveActorSession: true,
  });
}
