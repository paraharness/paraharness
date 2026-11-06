import type { DomainStepASTNode, StepASTNode } from '../../ast/domain-ast.types.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import { executeAgent } from '../agent/execute-agent.js';
import { executeLoop } from '../loop/execute-loop.js';
import { executeCommand } from './execute-command.js';

/**
 * Dispatches any passive `StepASTNode` (`AgentNode`, `LoopNode`, `CommandNode`, or adapter `DomainStepASTNode`) to its runtime executor (`SPEC.md` §2.3).
 *
 * Built-in step variants narrow at compile time via `switch (node.type)`, whereas adapter-supplied
 * domain step nodes dispatch through `ctx.registry.steps[node.type]` with zero unsafe type casts.
 *
 * @template TIn     Validated step input payload type.
 * @template TOut    Validated step output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {StepASTNode<TIn, TOut, THandle>} node  - Passive step AST node to execute.
 * @param {TIn}                             input - Raw or pre-mapped step input payload.
 * @param {StepExecutionContext<THandle>}   ctx   - Active step execution context.
 *
 * @returns {Promise<TOut>} Schema-validated output payload produced by the step executor.
 */
export async function executeStepNode<TIn = unknown, TOut = unknown, THandle = unknown>(
  node: StepASTNode<TIn, TOut, THandle>,
  input: TIn,
  ctx: StepExecutionContext<THandle>,
): Promise<TOut> {
  switch (node.type) {
    case 'harness:agent':
      return executeAgent(node, input, ctx);
    case 'harness:loop':
      return executeLoop(node, input, ctx);
    case 'harness:command':
      return executeCommand(node, input, ctx);
    default: {
      const domainStep: DomainStepASTNode<TIn, TOut, THandle> = node;
      const executor = ctx.registry.steps[domainStep.type];
      if (executor === undefined) {
        const registered = Object.keys(ctx.registry.steps).join(', ') || '<none>';
        throw new Error(
          `No StepExecutor registered for '${domainStep.type}' (runId '${ctx.runId}', stepExecId '${ctx.stepExecId}'). Registered: [${registered}].`,
        );
      }
      return Promise.resolve(executor(domainStep as never, input as never, ctx as never)) as Promise<TOut>;
    }
  }
}
