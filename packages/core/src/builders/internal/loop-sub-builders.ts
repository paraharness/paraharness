import type { z } from 'zod';
import type { AgentNode } from '../../ast/agent-node.js';
import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { ToolASTNode } from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { LessonsNode } from '../../ast/lessons-node.js';
import type { LoopNode } from '../../ast/loop-node.js';
import type { PolicyNode } from '../../ast/policy-node.js';
import type { ExtractEvalScopeReceipt } from '../flow-extraction.types.js';
import type { LoopBuilder } from '../loop-builder.js';
import type { LoopEvaluateOptions } from '../loop-evaluate-options.js';
import { flattenExtractedNodes } from './agent-and-loop-sub-builders.js';
import { compileLoopStateToNode } from './compile-loop-state-to-node.js';
import { assertNonEmptyIdentifier, deepFreeze } from './deep-freeze.js';
import { deriveCanonicalRoleKey } from './derive-canonical-role-key.js';
import type { LoopBuilderState } from './loop-builder-state.js';

export type { LoopBuilderState } from './loop-builder-state.js';

/**
 * Creates an immutable `LoopBuilder` from an internal state snapshot.
 *
 * Provides copy-on-write fluent transitions for `.input()`, `.output()`, `.act()`,
 * `.evaluate()`, `.returnOutputFrom()`, `.withPolicy()`, and `.withTools()` while
 * recomputing canonical `roleKey` hashes on toolset overrides.
 *
 * @template TIn        Validated loop input payload type.
 * @template TOut       Validated loop output payload type.
 * @template THandle    Runtime handle type of the active isolation scope.
 * @template TActStepId Literal action step identifier.
 *
 * @param {LoopBuilderState<TIn, TOut, THandle, TActStepId>} state - Current loop builder state.
 *
 * @returns {LoopBuilder<TIn, TOut, THandle, TActStepId>} Frozen loop builder.
 */
export function createLoopFromState<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
  TActStepId extends string = string,
>(
  state: LoopBuilderState<TIn, TOut, THandle, TActStepId>,
): LoopBuilder<TIn, TOut, THandle, TActStepId> {
  return Object.freeze<LoopBuilder<TIn, TOut, THandle, TActStepId>>({
    id: state.id,
    roleKey: state.roleKey,
    input: <TNewIn>(schema: z.ZodType<TNewIn, z.ZodTypeDef, unknown>) =>
      createLoopFromState<TNewIn, TOut, THandle, TActStepId>({
        ...state,
        inputSchema: schema,
        extractPartitions: undefined,
        actStep: undefined,
        evaluateStep: undefined,
      }),
    output: <TNewOut>(schema: z.ZodType<TNewOut, z.ZodTypeDef, unknown>) =>
      createLoopFromState<TIn, TNewOut, THandle, TActStepId>({
        ...state,
        outputSchema: schema,
        actStep: undefined,
        evaluateStep: undefined,
      }),
    partitions: (extractor: (input: TIn) => readonly string[]) =>
      createLoopFromState({ ...state, extractPartitions: extractor }),
    maxIterations: (count: number) => {
      if (!Number.isInteger(count) || count < 1) {
        throw new Error(`Loop '${state.id}' requires maxIterations >= 1 (received ${count}).`);
      }
      return createLoopFromState({ ...state, maxIterations: count });
    },
    preserveActorSession: (preserve: boolean) =>
      createLoopFromState({ ...state, preserveActorSession: preserve }),
    distillLessonsInto: (lessons: MaybeBuilder<LessonsNode<unknown>>) =>
      createLoopFromState({ ...state, distillLessons: extractAST(lessons) }),
    act: <TNewActStepId extends string>(
      stepId: TNewActStepId,
      actor: MaybeBuilder<AgentNode<TIn, TOut, THandle>>,
    ) => {
      assertNonEmptyIdentifier('H.loop.act', stepId);
      const actorNode = extractAST(actor);
      return createLoopFromState<TIn, TOut, THandle, TNewActStepId>({
        ...state,
        roleKey: actorNode.roleKey,
        actStep: { stepId, actor: actorNode },
        returnOutputFromStepId: undefined,
      });
    },
    evaluate: <TEvalIn, TEvalOut, TReceipt = ExtractEvalScopeReceipt<TEvalIn>>(
      stepId: string,
      evaluator: MaybeBuilder<AgentNode<TEvalIn, TEvalOut, THandle>>,
      options: LoopEvaluateOptions<TIn, TOut, TEvalIn, TEvalOut, TReceipt>,
    ) => {
      assertNonEmptyIdentifier('H.loop.evaluate', stepId);
      return createLoopFromState({
        ...state,
        evaluateStep: {
          stepId,
          evaluator: extractAST(evaluator),
          mapInput: options.mapInput,
          acceptWhen: options.acceptWhen,
          feedbackMapper: options.feedbackMapper,
        },
      });
    },
    returnOutputFrom: (actStepId: TActStepId) => {
      if (state.actStep !== undefined && actStepId !== state.actStep.stepId) {
        throw new Error(
          `Loop '${state.id}' returnOutputFrom('${actStepId}') must match the .act() step ID ('${state.actStep.stepId}').`,
        );
      }
      return createLoopFromState({ ...state, returnOutputFromStepId: actStepId });
    },
    withPolicy: (newPolicy: MaybeBuilder<PolicyNode<THandle>>) => {
      if (state.actStep === undefined) {
        throw new Error(`Loop '${state.id}' cannot call .withPolicy() before .act().`);
      }
      const updatedActor: AgentNode<TIn, TOut, THandle> = deepFreeze<AgentNode<TIn, TOut, THandle>>({
        ...state.actStep.actor,
        policy: extractAST(newPolicy),
      });
      return createLoopFromState({
        ...state,
        actStep: { stepId: state.actStep.stepId, actor: updatedActor },
      });
    },
    withTools: (
      ...extraTools: ReadonlyArray<
        MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>
      >
    ) => {
      if (state.actStep === undefined) {
        throw new Error(`Loop '${state.id}' cannot call .withTools() before .act().`);
      }
      const addedTools = flattenExtractedNodes<ToolASTNode<THandle>>(extraTools);
      const nextRoleKey = deriveCanonicalRoleKey(state.actStep.actor.roleKey, addedTools);
      const updatedActor: AgentNode<TIn, TOut, THandle> = deepFreeze<AgentNode<TIn, TOut, THandle>>({
        ...state.actStep.actor,
        roleKey: nextRoleKey,
        tools: [...state.actStep.actor.tools, ...addedTools],
      });
      return createLoopFromState({
        ...state,
        roleKey: nextRoleKey,
        actStep: { stepId: state.actStep.stepId, actor: updatedActor },
      });
    },
    toAST: (): LoopNode<TIn, TOut, THandle, TActStepId> => compileLoopStateToNode(state),
  });
}
