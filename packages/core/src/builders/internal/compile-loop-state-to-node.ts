import type { LoopNode } from '../../ast/loop-node.js';
import { deepFreeze } from './deep-freeze.js';
import type { LoopBuilderState } from './loop-builder-state.js';

/**
 * Validates and compiles a `LoopBuilderState` into a deeply frozen `LoopNode`.
 *
 * Ensures that `.input()`, `.output()`, `.act()`, `.evaluate()`, and `.returnOutputFrom()`
 * are all configured and that `.returnOutputFrom()` matches the `.act()` step identifier.
 *
 * @template TIn        Loop input payload type.
 * @template TOut       Loop output payload type.
 * @template THandle    Isolation scope handle type.
 * @template TActStepId Literal action step identifier.
 *
 * @param {LoopBuilderState<TIn, TOut, THandle, TActStepId>} state - Current loop builder state.
 *
 * @returns {LoopNode<TIn, TOut, THandle, TActStepId>} Deeply frozen `LoopNode`.
 */
export function compileLoopStateToNode<TIn, TOut, THandle, TActStepId extends string>(
  state: LoopBuilderState<TIn, TOut, THandle, TActStepId>,
): LoopNode<TIn, TOut, THandle, TActStepId> {
  const missing: string[] = [];
  if (state.inputSchema === undefined) missing.push('.input(schema)');
  if (state.outputSchema === undefined) missing.push('.output(schema)');
  if (state.actStep === undefined) missing.push('.act(stepId, actor)');
  if (state.evaluateStep === undefined) missing.push('.evaluate(stepId, evaluator, options)');
  if (state.returnOutputFromStepId === undefined) missing.push('.returnOutputFrom(stepId)');
  if (
    missing.length > 0 ||
    state.inputSchema === undefined ||
    state.outputSchema === undefined ||
    state.actStep === undefined ||
    state.evaluateStep === undefined ||
    state.returnOutputFromStepId === undefined
  ) {
    throw new Error(
      `Loop '${state.id}' is missing required ${missing.join(', ')} configuration before .toAST().`,
    );
  }
  if (state.returnOutputFromStepId !== state.actStep.stepId) {
    throw new Error(
      `Loop '${state.id}' returnOutputFrom('${state.returnOutputFromStepId}') must match the .act() step ID ('${state.actStep.stepId}').`,
    );
  }
  return deepFreeze<LoopNode<TIn, TOut, THandle, TActStepId>>({
    type: 'harness:loop',
    id: state.id,
    roleKey: state.actStep.actor.roleKey,
    inputSchema: state.inputSchema,
    outputSchema: state.outputSchema,
    extractPartitions: state.extractPartitions,
    maxIterations: state.maxIterations,
    preserveActorSession: state.preserveActorSession,
    distillLessons: state.distillLessons,
    actStep: state.actStep,
    evaluateStep: state.evaluateStep,
    returnOutputFromStepId: state.returnOutputFromStepId,
  });
}
