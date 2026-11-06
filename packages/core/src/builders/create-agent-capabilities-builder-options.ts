import type { EscalateCapabilityNode } from '../ast/escalate-capability-node.js';
import type { ForkCapabilityNode } from '../ast/fork-capability-node.js';
import type { MutatePlanCapabilityNode } from '../ast/mutate-plan-capability-node.js';
import type { SpeculateCapabilityNode } from '../ast/speculate-capability-node.js';

/**
 * Internal copy-on-write state for `createAgentCapabilitiesBuilder`.
 *
 * Holds the accumulated fork, speculate, mutatePlan, and escalate capability nodes
 * declared on an agent.
 *
 * @template TParentIn Parent actor input payload type.
 * @template THandle   Isolation scope handle type.
 */
export interface CreateAgentCapabilitiesBuilderOptions<TParentIn = unknown, THandle = unknown> {
  /** Registered fork capabilities. */
  readonly forks?: readonly ForkCapabilityNode<TParentIn, unknown, unknown, unknown, THandle>[];
  /** Registered speculate capabilities. */
  readonly speculations?: readonly SpeculateCapabilityNode<
    TParentIn,
    unknown,
    unknown,
    unknown,
    THandle,
    unknown,
    unknown
  >[];
  /** Optional mutatePlan capability. */
  readonly mutatePlan?: MutatePlanCapabilityNode<unknown>;
  /** Registered escalate capabilities. */
  readonly escalations?: readonly EscalateCapabilityNode<unknown, unknown>[];
}
