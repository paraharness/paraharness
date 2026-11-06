import type { AgentCapabilitiesNode } from '../ast/agent-capabilities-node.js';
import type { AgentNode } from '../ast/agent-node.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { EscalateCapabilityNode } from '../ast/escalate-capability-node.js';
import type { ForkCapabilityNode } from '../ast/fork-capability-node.js';
import type { InterruptNode } from '../ast/interrupt-node.js';
import type { LoopNode } from '../ast/loop-node.js';
import type { MutatePlanCapabilityNode } from '../ast/mutate-plan-capability-node.js';
import type { SpeculateCapabilityNode } from '../ast/speculate-capability-node.js';
import type { AgentCapabilitiesBuilder } from './agent-capabilities-builder.js';
import type { CreateAgentCapabilitiesBuilderOptions } from './create-agent-capabilities-builder-options.js';
import { createEscalateCapabilityBuilder } from './create-escalate-capability-builder.js';
import { createForkCapabilityBuilder } from './create-fork-capability-builder.js';
import { createMutatePlanCapabilityBuilder } from './create-mutate-plan-capability-builder.js';
import { createSpeculateCapabilityBuilder } from './create-speculate-capability-builder.js';
import type { EscalateCapabilityBuilder } from './escalate-capability-builder.js';
import type { ForkCapabilityBuilder } from './fork-capability-builder.js';
import { deepFreeze } from './internal/deep-freeze.js';
import type { MutatePlanCapabilityBuilder } from './mutate-plan-capability-builder.js';
import type { SpeculateCapabilityBuilder } from './speculate-capability-builder.js';

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
  const forks = options?.forks ?? [];
  const speculations = options?.speculations ?? [];
  const mutatePlan = options?.mutatePlan;
  const escalations = options?.escalations ?? [];

  return Object.freeze<AgentCapabilitiesBuilder<TParentIn, THandle>>({
    fork<TChildIn, TChildOut>(
      toolName: string,
      childExecutable: MaybeBuilder<
        AgentNode<TChildIn, TChildOut, THandle> | LoopNode<TChildIn, TChildOut, THandle, string>
      >,
      configure: (
        $f: ForkCapabilityBuilder<TParentIn, unknown, TChildIn, TChildOut, THandle>,
      ) => AstBuilder<ForkCapabilityNode<TParentIn, unknown, TChildIn, TChildOut, THandle>>,
    ): AgentCapabilitiesBuilder<TParentIn, THandle> {
      const forkNode = configure(
        createForkCapabilityBuilder<TParentIn, TChildIn, TChildOut, THandle>(
          toolName,
          childExecutable,
        ),
      ).toAST();
      return createAgentCapabilitiesBuilder<TParentIn, THandle>({
        forks: [...forks, forkNode],
        speculations,
        mutatePlan,
        escalations,
      });
    },
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
    ): AgentCapabilitiesBuilder<TParentIn, THandle> {
      const specNode = configure(
        createSpeculateCapabilityBuilder<TParentIn, THandle>(toolName),
      ).toAST();
      return createAgentCapabilitiesBuilder<TParentIn, THandle>({
        forks,
        speculations: [...speculations, specNode],
        mutatePlan,
        escalations,
      });
    },
    mutatePlan(
      configure: (
        $m: MutatePlanCapabilityBuilder<unknown>,
      ) => AstBuilder<MutatePlanCapabilityNode<unknown>>,
    ): AgentCapabilitiesBuilder<TParentIn, THandle> {
      const mutatePlanNode = configure(createMutatePlanCapabilityBuilder()).toAST();
      return createAgentCapabilitiesBuilder<TParentIn, THandle>({
        forks,
        speculations,
        mutatePlan: mutatePlanNode,
        escalations,
      });
    },
    escalate<TPayload>(
      interrupt: MaybeBuilder<InterruptNode<TPayload>>,
      configure: (
        $esc: EscalateCapabilityBuilder<TPayload, unknown>,
      ) => AstBuilder<EscalateCapabilityNode<TPayload, unknown>>,
    ): AgentCapabilitiesBuilder<TParentIn, THandle> {
      const escalateNode = configure(createEscalateCapabilityBuilder<TPayload>(interrupt)).toAST();
      return createAgentCapabilitiesBuilder<TParentIn, THandle>({
        forks,
        speculations,
        mutatePlan,
        escalations: [...escalations, escalateNode],
      });
    },
    toAST(): AgentCapabilitiesNode<TParentIn, THandle> {
      return deepFreeze<AgentCapabilitiesNode<TParentIn, THandle>>({
        type: 'harness:agent-capabilities',
        forks,
        speculations,
        mutatePlan,
        escalations,
      });
    },
  });
}
