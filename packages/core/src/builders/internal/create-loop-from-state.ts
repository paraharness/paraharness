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
import { compileLoopStateToNode } from './compile-loop-state-to-node.js';
import { assertNonEmptyIdentifier, deepFreeze } from './deep-freeze.js';
import { deriveCanonicalRoleKey } from './derive-canonical-role-key.js';
import { flattenExtractedNodes } from './flatten-builder-inputs.js';
import type { LoopBuilderState } from './loop-builder-state.js';

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
export function createLoopFromState<TIn = unknown, TOut = unknown, THandle = unknown, TActStepId extends string = string>(
  state: LoopBuilderState<TIn, TOut, THandle, TActStepId>,
): LoopBuilder<TIn, TOut, THandle, TActStepId> {
  return Object.freeze<LoopBuilder<TIn, TOut, THandle, TActStepId>>({
    id: state.id,
    roleKey: state.roleKey,
    input: <TNewIn>(schema: z.ZodType<TNewIn>) => {
      const wideActActor: AgentNode<unknown, TOut, THandle> | undefined =
        state.actStep !== undefined ? deepFreeze<AgentNode<unknown, TOut, THandle>>({ ...state.actStep.actor, inputSchema: schema }) : undefined;
      const wideState: LoopBuilderState<unknown, TOut, THandle, TActStepId> = {
        ...state,
        inputSchema: undefined,
        actStep: state.actStep !== undefined && wideActActor !== undefined ? { stepId: state.actStep.stepId, actor: wideActActor } : undefined,
      };
      return createLoopFromState<TNewIn, TOut, THandle, TActStepId>({
        ...wideState,
        inputSchema: schema,
        actStep:
          state.actStep !== undefined && wideActActor !== undefined
            ? { stepId: state.actStep.stepId, actor: deepFreeze<AgentNode<TNewIn, TOut, THandle>>({ ...wideActActor, inputSchema: schema }) }
            : undefined,
      });
    },
    output: <TNewOut>(schema: z.ZodType<TNewOut>) => {
      const wideActActor: AgentNode<TIn, unknown, THandle> | undefined =
        state.actStep !== undefined ? deepFreeze<AgentNode<TIn, unknown, THandle>>({ ...state.actStep.actor, outputSchema: schema }) : undefined;
      const wideState: LoopBuilderState<TIn, unknown, THandle, TActStepId> = {
        ...state,
        outputSchema: undefined,
        actStep: state.actStep !== undefined && wideActActor !== undefined ? { stepId: state.actStep.stepId, actor: wideActActor } : undefined,
      };
      return createLoopFromState<TIn, TNewOut, THandle, TActStepId>({
        ...wideState,
        outputSchema: schema,
        actStep:
          state.actStep !== undefined && wideActActor !== undefined
            ? { stepId: state.actStep.stepId, actor: deepFreeze<AgentNode<TIn, TNewOut, THandle>>({ ...wideActActor, outputSchema: schema }) }
            : undefined,
      });
    },
    partitions: (extractor: (input: TIn) => readonly string[]) => createLoopFromState({ ...state, extractPartitions: extractor }),
    maxIterations: (count: number) => {
      if (!Number.isInteger(count) || count < 1) throw new Error(`Loop '${state.id}' requires maxIterations >= 1 (received ${count}).`);
      return createLoopFromState({ ...state, maxIterations: count });
    },
    preserveActorSession: (preserve: boolean) => createLoopFromState({ ...state, preserveActorSession: preserve }),
    distillLessonsInto: (lessons: MaybeBuilder<LessonsNode<unknown>>) => createLoopFromState({ ...state, distillLessons: extractAST(lessons) }),
    act: <
      TNewActStepId extends string,
      TActIn extends TIn = TIn,
      TActOut extends TOut = TOut,
      TActHandle = THandle,
    >(
      stepId: TNewActStepId,
      actor: MaybeBuilder<AgentNode<TActIn, TActOut, TActHandle>>,
    ) => {
      assertNonEmptyIdentifier('P.loop.act', stepId);
      const actorNode = extractAST(actor);
      return createLoopFromState<
        TActIn,
        TActOut,
        [unknown] extends [THandle] ? TActHandle : THandle,
        TNewActStepId
      >({
        id: state.id,
        roleKey: actorNode.roleKey,
        inputSchema: actorNode.inputSchema,
        outputSchema: actorNode.outputSchema,
        extractPartitions: state.extractPartitions ?? actorNode.extractPartitions,
        maxIterations: state.maxIterations,
        preserveActorSession: state.preserveActorSession,
        distillLessons: state.distillLessons,
        actStep: {
          stepId,
          actor: actorNode as AgentNode<
            TActIn,
            TActOut,
            [unknown] extends [THandle] ? TActHandle : THandle
          >,
        },
        evaluateStep: state.evaluateStep as
          | LoopBuilderState<
              TActIn,
              TActOut,
              [unknown] extends [THandle] ? TActHandle : THandle,
              TNewActStepId
            >['evaluateStep']
          | undefined,
        returnOutputFromStepId: (state.returnOutputFromStepId ?? stepId) as TNewActStepId,
      });
    },
    evaluate: <TEvalIn, TEvalOut, TReceipt = ExtractEvalScopeReceipt<TEvalIn>>(
      stepId: string,
      evaluator: MaybeBuilder<AgentNode<TEvalIn, TEvalOut, THandle>>,
      options: LoopEvaluateOptions<TIn, TOut, TEvalIn, TEvalOut, TReceipt>,
    ) => {
      assertNonEmptyIdentifier('P.loop.evaluate', stepId);
      return createLoopFromState({
        ...state,
        evaluateStep: { stepId, evaluator: extractAST(evaluator), mapInput: options.mapInput, acceptWhen: options.acceptWhen, feedbackMapper: options.feedbackMapper },
      });
    },
    returnOutputFrom: (actStepId: TActStepId) => {
      if (state.actStep !== undefined && actStepId !== state.actStep.stepId) {
        throw new Error(`Loop '${state.id}' returnOutputFrom('${actStepId}') must match the .act() step ID ('${state.actStep.stepId}').`);
      }
      return createLoopFromState({ ...state, returnOutputFromStepId: actStepId });
    },
    withPolicy: (newPolicy: MaybeBuilder<PolicyNode<THandle>>) => {
      if (state.actStep === undefined) throw new Error(`Loop '${state.id}' cannot call .withPolicy() before .act().`);
      const updatedActor = deepFreeze<AgentNode<TIn, TOut, THandle>>({ ...state.actStep.actor, policy: extractAST(newPolicy) });
      return createLoopFromState({ ...state, actStep: { stepId: state.actStep.stepId, actor: updatedActor } });
    },
    withTools: (...extraTools: ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>>) => {
      if (state.actStep === undefined) throw new Error(`Loop '${state.id}' cannot call .withTools() before .act().`);
      const addedTools = flattenExtractedNodes<ToolASTNode<THandle>>(extraTools);
      const nextRoleKey = deriveCanonicalRoleKey(state.actStep.actor.roleKey, addedTools);
      const updatedActor = deepFreeze<AgentNode<TIn, TOut, THandle>>({ ...state.actStep.actor, roleKey: nextRoleKey, tools: [...state.actStep.actor.tools, ...addedTools] });
      return createLoopFromState({ ...state, roleKey: nextRoleKey, actStep: { stepId: state.actStep.stepId, actor: updatedActor } });
    },
    toAST: (): LoopNode<TIn, TOut, THandle, TActStepId> => compileLoopStateToNode(state),
  });
}
