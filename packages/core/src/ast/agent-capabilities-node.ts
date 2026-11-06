import type { EscalateCapabilityNode } from './escalate-capability-node.js';
import type { ForkCapabilityNode } from './fork-capability-node.js';
import type { MutatePlanCapabilityNode } from './mutate-plan-capability-node.js';
import type { SpeculateCapabilityNode } from './speculate-capability-node.js';

/**
 * Passive AST node aggregating all hierarchical orchestration capabilities mounted on an `AgentNode` (`.capabilities($cap => ...)`).
 *
 * Groups downward child forks, parallel speculative tournaments, dynamic plan/contract mutations,
 * and voluntary exogenous human escalations exposed as capability tools on the parent agent.
 *
 * @template TParentIn Parent actor input payload type.
 * @template THandle   Runtime handle type of the active isolation scope.
 */
export interface AgentCapabilitiesNode<TParentIn = unknown, THandle = unknown> {
  /** Discriminant identifying an agent capabilities container AST node. */
  readonly type: 'harness:agent-capabilities';
  /** Registered downward fork capability tools (`.fork(...)`). */
  readonly forks: readonly ForkCapabilityNode<TParentIn, unknown, unknown, unknown, THandle>[];
  /** Registered speculative tournament capability tools (`.speculate(...)`). */
  readonly speculations: readonly SpeculateCapabilityNode<
    TParentIn,
    unknown,
    unknown,
    unknown,
    THandle,
    unknown,
    unknown
  >[];
  /** Optional plan and topology contract mutation capability (`.mutatePlan(...)`). */
  readonly mutatePlan?: MutatePlanCapabilityNode<unknown>;
  /** Registered voluntary human escalation capability tools (`.escalate(...)`). */
  readonly escalations: readonly EscalateCapabilityNode<unknown, unknown>[];
}
