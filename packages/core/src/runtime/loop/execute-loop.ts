import type { LoopNode } from '../../ast/loop-node.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import { initializeLoopExecutionState } from './internal/initialize-loop-execution-state.js';
import { projectLoopChildOutcomeSink } from './internal/project-loop-child-outcome-sink.js';
import { runLoopIterationsUntilAccepted } from './internal/run-loop-iterations-until-accepted.js';

/**
 * Executes a passive `LoopNode` across `.act() -> .evaluate()` iterations up to `maxIterations` (`SPEC.md` §3.8).
 *
 * Sequences state initialization, iteration execution (`runLoopIterationsUntilAccepted`), output validation,
 * and `childOutcomeSink` projection (`projectLoopChildOutcomeSink`) at one uniform level of abstraction (`Rule 3.1`).
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopNode<TIn, TOut, THandle>}  node  - Passive `LoopNode` AST definition.
 * @param {TIn}                           input - Raw or pre-mapped loop input payload.
 * @param {StepExecutionContext<THandle>} ctx   - Active step execution context.
 *
 * @returns {Promise<TOut>} Schema-validated loop output payload from `returnOutputFromStepId`.
 */
export async function executeLoop<TIn = unknown, TOut = unknown, THandle = unknown>(
  node: LoopNode<TIn, TOut, THandle>,
  input: TIn,
  ctx: StepExecutionContext<THandle>,
): Promise<TOut> {
  const validatedInput = node.inputSchema.parse(input);
  const state = initializeLoopExecutionState(node, validatedInput, ctx);
  try {
    const rawOutput = await runLoopIterationsUntilAccepted(state);
    return node.outputSchema.parse(rawOutput);
  } finally {
    projectLoopChildOutcomeSink(ctx, state);
  }
}
