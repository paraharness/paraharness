import type { z } from 'zod';
import type { AgentNode } from '../../ast/agent-node.js';
import type { AstBuilder } from '../../ast/ast-builder.js';
import type { MaybeBuilder, MaybeSource } from '../../ast/ast-foundation.types.js';
import type {
  CheckASTNode,
  ModelASTNode,
  SourceASTNode,
  ToolASTNode,
} from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { InterruptHandlerNode } from '../../ast/interrupt-handler-node.js';
import type { InterruptNode } from '../../ast/interrupt-node.js';
import type { LessonsNode } from '../../ast/lessons-node.js';
import type { PolicyNode } from '../../ast/policy-node.js';
import type { PoolNode } from '../../ast/pool-node.js';
import type { PrefixGroupNode } from '../../ast/prefix-group-node.js';
import type { RulesNode } from '../../ast/rules-node.js';
import type { SkillNode } from '../../ast/skill-node.js';
import type { TopologyNode } from '../../ast/topology-node.js';
import type { AgentBuilder } from '../agent-builder.js';
import type { AgentCapabilitiesBuilder } from '../agent-capabilities-builder.js';
import type { ChildInterruptHandlerBuilder } from '../child-interrupt-handler-builder.js';
import { createAgentCapabilitiesBuilder } from '../create-agent-capabilities-builder.js';
import { createChildInterruptHandlerBuilder } from '../create-child-interrupt-handler-builder.js';
import { createInterruptEdgeBuilder } from '../create-interrupt-edge-builder.js';
import type { InterruptEdgeBuilder } from '../interrupt-edge-builder.js';
import type { AgentBuilderState } from './agent-builder-state.js';
import { deriveCanonicalRoleKey } from './derive-canonical-role-key.js';
import {
  compileAgentStateToNode,
  flattenExtractedNodes,
  flattenSourceStrings,
} from './flatten-builder-inputs.js';

export { flattenExtractedNodes, flattenSourceStrings };

/**
 * Creates a copy-on-write immutable `AgentBuilder` from an internal state snapshot.
 *
 * Every fluent method returns a new frozen `AgentBuilder` instance without mutating `state`,
 * and `.toAST()` validates and deeply freezes the resulting `AgentNode`.
 *
 * @template TIn     Validated actor input payload type.
 * @template TOut    Validated actor output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentBuilderState<TIn, TOut, THandle>} state - Current agent builder state.
 *
 * @returns {AgentBuilder<TIn, TOut, THandle>} Frozen `AgentBuilder` instance.
 */
export function createAgentFromState<TIn = unknown, TOut = unknown, THandle = unknown>(
  state: AgentBuilderState<TIn, TOut, THandle>,
): AgentBuilder<TIn, TOut, THandle> {
  return Object.freeze<AgentBuilder<TIn, TOut, THandle>>({
    id: state.id,
    roleKey: state.roleKey,
    prefixGroup: (group: MaybeBuilder<PrefixGroupNode>) =>
      createAgentFromState({ ...state, prefixGroup: extractAST(group) }),
    model: (modelOrPool: MaybeBuilder<ModelASTNode> | MaybeBuilder<PoolNode<ModelASTNode>>) =>
      createAgentFromState({ ...state, model: extractAST(modelOrPool) }),
    topology: <TPart extends string = string>(topology: MaybeBuilder<TopologyNode<TPart>>) =>
      createAgentFromState({ ...state, topology: extractAST(topology) }),
    rules: (rules: MaybeBuilder<RulesNode>) =>
      createAgentFromState({ ...state, rules: extractAST(rules) }),
    lessons: <TLessonIn = unknown>(
      lessons: MaybeBuilder<LessonsNode<TLessonIn>>,
      opts?: { readonly recordOutcomes?: boolean },
    ) =>
      createAgentFromState({
        ...state,
        lessons: { node: extractAST(lessons), recordOutcomes: opts?.recordOutcomes ?? true },
      }),
    skills: (
      ...items: ReadonlyArray<
        | MaybeBuilder<SkillNode<THandle>>
        | MaybeBuilder<SourceASTNode<readonly SkillNode<THandle>[]>>
        | ReadonlyArray<MaybeBuilder<SkillNode<THandle>>>
      >
    ) =>
      createAgentFromState({
        ...state,
        skills: [
          ...state.skills,
          ...flattenExtractedNodes<
            SkillNode<THandle> | SourceASTNode<readonly SkillNode<THandle>[]>
          >(items),
        ],
      }),
    policy: (policy: MaybeBuilder<PolicyNode<THandle>>) =>
      createAgentFromState({ ...state, policy: extractAST(policy) }),
    tools: (
      ...items: ReadonlyArray<
        MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>
      >
    ) =>
      createAgentFromState({
        ...state,
        baseTools: [...state.baseTools, ...flattenExtractedNodes<ToolASTNode<THandle>>(items)],
      }),
    grounding: (
      ...sources: ReadonlyArray<MaybeSource<string> | ReadonlyArray<MaybeSource<string>>>
    ) =>
      createAgentFromState({
        ...state,
        grounding: [...state.grounding, ...flattenSourceStrings(sources)],
      }),
    instructions: (
      ...sources: ReadonlyArray<MaybeSource<string> | ReadonlyArray<MaybeSource<string>>>
    ) =>
      createAgentFromState({
        ...state,
        instructions: [...state.instructions, ...flattenSourceStrings(sources)],
      }),
    timeoutMinutes: (minutes: number) =>
      createAgentFromState({ ...state, timeoutMinutes: minutes }),
    beforeStop: (
      ...checks: ReadonlyArray<
        MaybeBuilder<CheckASTNode<THandle>> | ReadonlyArray<MaybeBuilder<CheckASTNode<THandle>>>
      >
    ) =>
      createAgentFromState({
        ...state,
        beforeStopChecks: [
          ...state.beforeStopChecks,
          ...flattenExtractedNodes<CheckASTNode<THandle>>(checks),
        ],
      }),
    input: <TNewIn>(schema: z.ZodType<TNewIn, z.ZodTypeDef, unknown>) =>
      createAgentFromState<TNewIn, TOut, THandle>({
        ...state,
        inputSchema: schema,
        extractPartitions: undefined,
        capabilities: undefined,
        onInterruptHandlers: [],
      }),
    partitions: (extractor: (input: TIn) => readonly string[]) =>
      createAgentFromState({ ...state, extractPartitions: extractor }),
    output: <TNewOut>(schema: z.ZodType<TNewOut, z.ZodTypeDef, unknown>) =>
      createAgentFromState<TIn, TNewOut, THandle>({ ...state, outputSchema: schema }),
    canRaise: (
      ...interrupts: ReadonlyArray<
        MaybeBuilder<InterruptNode<unknown>> | ReadonlyArray<MaybeBuilder<InterruptNode<unknown>>>
      >
    ) =>
      createAgentFromState({
        ...state,
        canRaiseInterrupts: [
          ...state.canRaiseInterrupts,
          ...flattenExtractedNodes<InterruptNode<unknown>>(interrupts),
        ],
      }),
    capabilities: (
      configure: (
        $cap: AgentCapabilitiesBuilder<TIn, THandle>,
      ) => AgentCapabilitiesBuilder<TIn, THandle>,
    ) =>
      createAgentFromState({
        ...state,
        capabilities: configure(
          createAgentCapabilitiesBuilder<TIn, THandle>(state.capabilities),
        ).toAST(),
      }),
    onChildInterrupt: <TPayload>(
      interrupt: MaybeBuilder<InterruptNode<TPayload>>,
      configure: (
        $intr: ChildInterruptHandlerBuilder<TPayload>,
      ) => ChildInterruptHandlerBuilder<TPayload>,
    ) =>
      createAgentFromState({
        ...state,
        onChildInterruptHandlers: [
          ...state.onChildInterruptHandlers,
          configure(createChildInterruptHandlerBuilder(interrupt)).toAST(),
        ],
      }),
    onInterrupt: <TPayload>(
      interrupt: MaybeBuilder<InterruptNode<TPayload>>,
      configure: (
        $intr: InterruptEdgeBuilder<TIn, TPayload, THandle>,
      ) => AstBuilder<InterruptHandlerNode<TIn, TPayload, THandle>>,
    ) =>
      createAgentFromState({
        ...state,
        onInterruptHandlers: [
          ...state.onInterruptHandlers,
          configure(createInterruptEdgeBuilder<TIn, TPayload, THandle>(interrupt)).toAST(),
        ],
      }),
    withPolicy: (newPolicy: MaybeBuilder<PolicyNode<THandle>>) =>
      createAgentFromState({ ...state, policy: extractAST(newPolicy) }),
    withTools: (
      ...extraTools: ReadonlyArray<
        MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>
      >
    ) => {
      const mergedExtra = [
        ...state.extraTools,
        ...flattenExtractedNodes<ToolASTNode<THandle>>(extraTools),
      ];
      return createAgentFromState({
        ...state,
        extraTools: mergedExtra,
        roleKey: deriveCanonicalRoleKey(state.id, mergedExtra),
      });
    },
    toAST: (): AgentNode<TIn, TOut, THandle> => compileAgentStateToNode(state),
  });
}
