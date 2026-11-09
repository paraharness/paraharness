import type { AgentCapabilitiesNode } from '../ast/agent-capabilities-node.js';
import type { AgentNode } from '../ast/agent-node.js';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { EscalateCapabilityNode } from '../ast/escalate-capability-node.js';
import type { ForkCapabilityNode } from '../ast/fork-capability-node.js';
import type { InterruptNode } from '../ast/interrupt-node.js';
import type { LoopNode } from '../ast/loop-node.js';
import type { MutatePlanCapabilityNode } from '../ast/mutate-plan-capability-node.js';
import type { SpeculateCapabilityNode } from '../ast/speculate-capability-node.js';
import type { EscalateCapabilityBuilder } from './escalate-capability-builder.js';
import type { ForkCapabilityBuilder } from './fork-capability-builder.js';
import type { MutatePlanCapabilityBuilder } from './mutate-plan-capability-builder.js';
import type { SpeculateCapabilityBuilder } from './speculate-capability-builder.js';

/**
 * Fluent builder for hierarchical orchestration capabilities mounted on an `AgentNode` (`.capabilities($cap => ...)`).
 *
 * Registers downward child forks (`.fork()`), parallel speculative tournaments (`.speculate()`),
 * dynamic lane/topology mutations (`.mutatePlan()`), and human escalations (`.escalate()`).
 *
 * @template TParentIn Parent actor input payload type.
 * @template THandle   Runtime handle type of the active isolation scope.
 */
export interface AgentCapabilitiesBuilder<TParentIn = unknown, THandle = unknown>
  extends AstBuilder<AgentCapabilitiesNode<TParentIn, THandle>> {
  /**
   * Registers a downward child fork capability tool (`$cap.fork(toolName, childExecutable, configure?)`).
   *
   * Requires the enclosing flow's isolation scope to have `capabilityTier: 'branchable'`.
   * Defaults `requestSchema` to `childExecutable.inputSchema` and `mapInput` to `(_parentIn, req) => req`
   * when omitted.
   *
   * @template TChildIn  Child executable input payload type.
   * @template TChildOut Child executable output payload type.
   *
   * @param {string}                                                                                                                                                              toolName        - Tool name exposed to the parent agent.
   * @param {MaybeBuilder<AgentNode<TChildIn, TChildOut, THandle> | LoopNode<TChildIn, TChildOut, THandle, string>>}                                                              childExecutable - Child agent or loop.
   * @param {($f: ForkCapabilityBuilder<TParentIn, TChildIn, TChildIn, TChildOut, THandle>) => AstBuilder<ForkCapabilityNode<TParentIn, unknown, TChildIn, TChildOut, THandle>>} [configure]     - Optional fork builder configurator callback.
   *
   * @returns {AgentCapabilitiesBuilder<TParentIn, THandle>} New immutable capabilities builder.
   */
  fork<TChildIn, TChildOut>(
    toolName: string,
    childExecutable: MaybeBuilder<
      AgentNode<TChildIn, TChildOut, THandle> | LoopNode<TChildIn, TChildOut, THandle, string>
    >,
    configure?: (
      $f: ForkCapabilityBuilder<TParentIn, TChildIn, TChildIn, TChildOut, THandle>,
    ) => AstBuilder<ForkCapabilityNode<TParentIn, unknown, TChildIn, TChildOut, THandle>>,
  ): AgentCapabilitiesBuilder<TParentIn, THandle>;

  /**
   * Registers a parallel speculative tournament capability tool (`$cap.speculate(toolName, $s => ...)`).
   *
   * Requires the enclosing flow's isolation scope to have `capabilityTier: 'branchable'`.
   *
   * @param {string}                                                                                                                                                                                                             toolName  - Tool name exposed to the parent agent.
   * @param {($s: SpeculateCapabilityBuilder<TParentIn, unknown, unknown, unknown, THandle, unknown, unknown, unknown>) => AstBuilder<SpeculateCapabilityNode<TParentIn, unknown, unknown, unknown, THandle, unknown, unknown>>} configure - Speculate builder configurator callback.
   *
   * @returns {AgentCapabilitiesBuilder<TParentIn, THandle>} New immutable capabilities builder.
   */
  speculate(
    toolName: string,
    configure: (
      $s: SpeculateCapabilityBuilder<
        TParentIn,
        unknown,
        unknown,
        unknown,
        THandle,
        unknown,
        unknown,
        unknown
      >,
    ) => AstBuilder<
      SpeculateCapabilityNode<TParentIn, unknown, unknown, unknown, THandle, unknown, unknown>
    >,
  ): AgentCapabilitiesBuilder<TParentIn, THandle>;

  /**
   * Registers dynamic lane plan and topology contract mutation capabilities (`$cap.mutatePlan($m => ...)`).
   *
   * Requires the enclosing flow's isolation scope to have `capabilityTier: 'branchable'`.
   *
   * @param {($m: MutatePlanCapabilityBuilder<unknown>) => AstBuilder<MutatePlanCapabilityNode<unknown>>} configure - Plan mutation configurator callback.
   *
   * @returns {AgentCapabilitiesBuilder<TParentIn, THandle>} New immutable capabilities builder.
   */
  mutatePlan(
    configure: (
      $m: MutatePlanCapabilityBuilder<unknown>,
    ) => AstBuilder<MutatePlanCapabilityNode<unknown>>,
  ): AgentCapabilitiesBuilder<TParentIn, THandle>;

  /**
   * Registers a voluntary exogenous human escalation capability tool (`$cap.escalate(interrupt, $esc => ...)`).
   *
   * Exposes a synthetic tool allowing the agent to page a bidirectional human authority.
   *
   * @template TPayload Escalation brief payload type validated by `interrupt.schema`.
   *
   * @param {MaybeBuilder<InterruptNode<TPayload>>}                                                                         interrupt - Target interrupt node or builder.
   * @param {($esc: EscalateCapabilityBuilder<TPayload, unknown>) => AstBuilder<EscalateCapabilityNode<TPayload, unknown>>} configure - Escalation configurator callback.
   *
   * @returns {AgentCapabilitiesBuilder<TParentIn, THandle>} New immutable capabilities builder.
   */
  escalate<TPayload>(
    interrupt: MaybeBuilder<InterruptNode<TPayload>>,
    configure: (
      $esc: EscalateCapabilityBuilder<TPayload, unknown>,
    ) => AstBuilder<EscalateCapabilityNode<TPayload, unknown>>,
  ): AgentCapabilitiesBuilder<TParentIn, THandle>;
}
