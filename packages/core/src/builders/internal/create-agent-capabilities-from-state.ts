import type { AgentCapabilitiesNode } from '../../ast/agent-capabilities-node.js';
import type { AgentNode } from '../../ast/agent-node.js';
import type { AstBuilder } from '../../ast/ast-builder.js';
import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { EscalateCapabilityNode } from '../../ast/escalate-capability-node.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { ForkCapabilityNode } from '../../ast/fork-capability-node.js';
import type { InterruptNode } from '../../ast/interrupt-node.js';
import type { LoopNode } from '../../ast/loop-node.js';
import type { MutatePlanCapabilityNode } from '../../ast/mutate-plan-capability-node.js';
import type { SpeculateCapabilityNode } from '../../ast/speculate-capability-node.js';
import type { AgentCapabilitiesBuilder } from '../agent-capabilities-builder.js';
import type { CreateAgentCapabilitiesBuilderOptions } from '../create-agent-capabilities-builder-options.js';
import type { EscalateCapabilityBuilder } from '../escalate-capability-builder.js';
import type { ForkCapabilityBuilder } from '../fork-capability-builder.js';
import type { MutatePlanCapabilityBuilder } from '../mutate-plan-capability-builder.js';
import type { SpeculateCapabilityBuilder } from '../speculate-capability-builder.js';
import { createEscalateFromState } from './create-escalate-from-state.js';
import { createForkCapabilityFromState } from './create-fork-capability-from-state.js';
import { createSpeculateFromState } from './create-speculate-from-state.js';
import { assertNonEmptyIdentifier, deepFreeze } from './deep-freeze.js';
import { createMutatePlanFromState } from './mutate-plan-and-escalate-sub-builders.js';

/**
 * Creates a copy-on-write immutable `AgentCapabilitiesBuilder` from an internal state snapshot.
 *
 * Accumulates `.fork()`, `.speculate()`, `.mutatePlan()`, and `.escalate()` capability
 * declarations without upward imports to public builder factories and compiles them into
 * a deeply frozen `AgentCapabilitiesNode`.
 *
 * @template TParentIn Parent actor input payload type.
 * @template THandle   Isolation scope handle type.
 *
 * @param {CreateAgentCapabilitiesBuilderOptions<TParentIn, THandle>} [options] - Optional internal copy-on-write state.
 *
 * @returns {AgentCapabilitiesBuilder<TParentIn, THandle>} Frozen capabilities builder.
 */
export function createAgentCapabilitiesFromState<TParentIn = unknown, THandle = unknown>(
  options?: CreateAgentCapabilitiesBuilderOptions<TParentIn, THandle>,
): AgentCapabilitiesBuilder<TParentIn, THandle> {
  const forks = options?.forks ?? [];
  const speculations = options?.speculations ?? [];
  const mutatePlan = options?.mutatePlan;
  const escalations = options?.escalations ?? [];

  return Object.freeze<AgentCapabilitiesBuilder<TParentIn, THandle>>({
    fork: <TChildIn, TChildOut>(
      toolName: string,
      childExecutable: MaybeBuilder<AgentNode<TChildIn, TChildOut, THandle> | LoopNode<TChildIn, TChildOut, THandle, string>>,
      configure: ($f: ForkCapabilityBuilder<TParentIn, unknown, TChildIn, TChildOut, THandle>) => AstBuilder<ForkCapabilityNode<TParentIn, unknown, TChildIn, TChildOut, THandle>>,
    ) => {
      assertNonEmptyIdentifier('P.agent.capabilities.fork', toolName);
      const forkNode = configure(
        createForkCapabilityFromState<TParentIn, unknown, TChildIn, TChildOut, THandle>({
          toolName,
          childExecutable: extractAST(childExecutable),
          historyMode: 'shared-prefix-only',
          requestSchema: undefined,
          mapInput: undefined,
          modelRouting: undefined,
        }),
      ).toAST();
      return createAgentCapabilitiesFromState({ forks: [...forks, forkNode], speculations, mutatePlan, escalations });
    },
    speculate: (
      toolName: string,
      configure: ($s: SpeculateCapabilityBuilder<TParentIn, unknown, unknown, unknown, THandle, unknown, unknown, unknown>) => AstBuilder<SpeculateCapabilityNode<TParentIn, unknown, unknown, unknown, THandle, unknown, unknown>>,
    ) => {
      assertNonEmptyIdentifier('P.agent.capabilities.speculate', toolName);
      const specNode = configure(createSpeculateFromState<TParentIn, unknown, unknown, unknown, THandle, unknown, unknown, unknown>({ toolName })).toAST();
      return createAgentCapabilitiesFromState({ forks, speculations: [...speculations, specNode], mutatePlan, escalations });
    },
    mutatePlan: (configure: ($m: MutatePlanCapabilityBuilder<unknown>) => AstBuilder<MutatePlanCapabilityNode<unknown>>) => {
      const mutatePlanNode = configure(
        createMutatePlanFromState({ spawnTasks: undefined, canAddDependencies: false, topologyToUpdate: undefined }),
      ).toAST();
      return createAgentCapabilitiesFromState({ forks, speculations, mutatePlan: mutatePlanNode, escalations });
    },
    escalate: <TPayload>(
      interrupt: MaybeBuilder<InterruptNode<TPayload>>,
      configure: ($esc: EscalateCapabilityBuilder<TPayload, unknown>) => AstBuilder<EscalateCapabilityNode<TPayload, unknown>>,
    ) => {
      const escalateNode = configure(
        createEscalateFromState<TPayload, unknown>({
          interrupt: extractAST(interrupt),
          human: undefined,
          responseSchema: undefined,
          elevateLeaseWhen: undefined,
        }),
      ).toAST();
      return createAgentCapabilitiesFromState({ forks, speculations, mutatePlan, escalations: [...escalations, escalateNode] });
    },
    toAST: (): AgentCapabilitiesNode<TParentIn, THandle> =>
      deepFreeze<AgentCapabilitiesNode<TParentIn, THandle>>({
        type: 'harness:agent-capabilities',
        forks,
        speculations,
        mutatePlan,
        escalations,
      }),
  });
}
