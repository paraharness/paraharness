import { createSpeculateFromState } from './internal/create-speculate-from-state.js';
import { assertNonEmptyIdentifier } from './internal/deep-freeze.js';
import type { SpeculateCapabilityBuilder } from './speculate-capability-builder.js';

/**
 * Creates a fluent `SpeculateCapabilityBuilder` for `cap.speculate(toolName, $s => ...)`.
 *
 * Validates that `toolName` is a non-empty identifier and returns an immutable
 * builder for configuring N-branch speculative tournaments.
 *
 * @template TParentIn Parent actor input payload type.
 * @template THandle   Isolation scope handle type.
 *
 * @param {string} toolName - Name of the synthesized speculation tool exposed to the parent agent.
 *
 * @returns {SpeculateCapabilityBuilder<TParentIn, unknown, unknown, unknown, THandle, unknown, unknown, unknown>} Frozen speculate capability builder.
 */
export function createSpeculateCapabilityBuilder<TParentIn = unknown, THandle = unknown>(
  toolName: string,
): SpeculateCapabilityBuilder<
  TParentIn,
  unknown,
  unknown,
  unknown,
  THandle,
  unknown,
  unknown,
  unknown
> {
  assertNonEmptyIdentifier('M.agent.capabilities.speculate', toolName);
  return createSpeculateFromState({ toolName });
}
