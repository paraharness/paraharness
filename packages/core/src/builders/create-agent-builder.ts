import type { AgentBuilder } from './agent-builder.js';
import { createAgentFromState } from './internal/agent-and-loop-sub-builders.js';
import { assertNonEmptyIdentifier } from './internal/deep-freeze.js';

/**
 * Creates a fluent `AgentBuilder` for `H.agent(id)`.
 *
 * Validates that `id` is a non-empty identifier and initializes an immutable
 * `AgentBuilder` with `roleKey` defaulting to `id`.
 *
 * @template THandle Isolation scope handle type.
 *
 * @param {string} id - Unique identifier of the base agent definition.
 *
 * @returns {AgentBuilder<unknown, unknown, THandle>} Frozen `AgentBuilder` instance.
 */
export function createAgentBuilder<THandle = unknown>(
  id: string,
): AgentBuilder<unknown, unknown, THandle> {
  assertNonEmptyIdentifier('H.agent', id);
  return createAgentFromState<unknown, unknown, THandle>({
    id,
    roleKey: id,
    skills: [],
    baseTools: [],
    extraTools: [],
    grounding: [],
    instructions: [],
    beforeStopChecks: [],
    canRaiseInterrupts: [],
    onChildInterruptHandlers: [],
    onInterruptHandlers: [],
  });
}
