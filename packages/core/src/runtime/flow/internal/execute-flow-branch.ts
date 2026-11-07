import type { FlowBranchNode } from '../../../ast/flow-branch-node.js';
import type { FlowExecutionContext } from '../flow-execution-context.js';
import { executeFlowStep } from './execute-flow-step.js';

/**
 * Evaluates a `FlowBranchNode` against `flowCtx.currentInput`, executes the first matching `when` case (or `otherwiseSteps`), and records output under `branchNode.id` (`SPEC.md` §3.9).
 *
 * Validates the final step output of the selected branch against `branchNode.outputSchema`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>}    flowCtx    - Active flow execution context.
 * @param {FlowBranchNode<TIn, unknown, THandle>} branchNode - Passive `FlowBranchNode` to evaluate.
 *
 * @returns {Promise<{ readonly status: 'completed' | 'suspended' | 'rewound'; readonly output?: unknown }>} Branch execution outcome.
 */
export async function executeFlowBranch<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  branchNode: FlowBranchNode<TIn, unknown, THandle>,
): Promise<{
  readonly status: 'completed' | 'suspended' | 'rewound';
  readonly output?: unknown;
}> {
  const matchedCase = branchNode.cases.find((c) => c.predicate(flowCtx.currentInput));
  const selectedSteps = matchedCase !== undefined ? matchedCase.steps : branchNode.otherwiseSteps;
  let lastOutput: unknown;
  for (const childNode of selectedSteps) {
    const childRes =
      childNode.type === 'harness:flow-step'
        ? await executeFlowStep(flowCtx, childNode, branchNode.id)
        : await executeFlowBranch(flowCtx, childNode as FlowBranchNode<TIn, unknown, THandle>);
    if (childRes.status !== 'completed') {
      return childRes;
    }
    lastOutput = childRes.output;
  }
  const validatedBranchOut = branchNode.outputSchema.parse(lastOutput);
  flowCtx.completedStepOutputs.set(branchNode.id, validatedBranchOut);
  return Object.freeze({ status: 'completed', output: validatedBranchOut });
}
