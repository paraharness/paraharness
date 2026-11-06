import type { AgentCapabilitiesBuilder } from './agent-capabilities-builder.js';
import type { CreateAgentCapabilitiesBuilderOptions } from './create-agent-capabilities-builder-options.js';
import { createAgentCapabilitiesFromState } from './internal/create-agent-capabilities-from-state.js';

/**
 * Creates a fluent `AgentCapabilitiesBuilder` for `agent.capabilities($cap => ...)`.
 *
 * Accumulates `.fork()`, `.speculate()`, `.mutatePlan()`, and `.escalate()` capability
 * declarations using copy-on-write state snapshots and compiles them into a deeply
 * frozen `AgentCapabilitiesNode`.
 *
 * @template TParentIn Parent actor input payload type.
 * @template THandle   Isolation scope handle type.
 *
 * @param {CreateAgentCapabilitiesBuilderOptions<TParentIn, THandle>} [options] - Optional internal copy-on-write state.
 *
 * @returns {AgentCapabilitiesBuilder<TParentIn, THandle>} Frozen capabilities builder.
 */
export function createAgentCapabilitiesBuilder<TParentIn = unknown, THandle = unknown>(
  options?: CreateAgentCapabilitiesBuilderOptions<TParentIn, THandle>,
): AgentCapabilitiesBuilder<TParentIn, THandle> {
  return createAgentCapabilitiesFromState<TParentIn, THandle>(options);
}
