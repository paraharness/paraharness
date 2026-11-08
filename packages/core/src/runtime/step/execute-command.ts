import type { CommandNode } from '../../ast/command-node.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';

/**
 * Executes a passive `CommandNode` (`M.command(id)`) by validating `input`, invoking `node.fn(validatedInput, ctx)`, and validating the returned output (`SPEC.md` §2.3 & §3.7).
 *
 * Enforces Declarative Compilation Invariant 6 (`node` is a passive AST record with zero `.execute` method; execution occurs exclusively here).
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {CommandNode<TIn, TOut, THandle>} node  - Passive `CommandNode` AST definition.
 * @param {TIn}                             input - Raw or pre-mapped command input payload.
 * @param {StepExecutionContext<THandle>}   ctx   - Active step execution context.
 *
 * @returns {Promise<TOut>} Schema-validated command output payload.
 */
export async function executeCommand<TIn = unknown, TOut = unknown, THandle = unknown>(
  node: CommandNode<TIn, TOut, THandle>,
  input: TIn,
  ctx: StepExecutionContext<THandle>,
): Promise<TOut> {
  const validatedInput = node.inputSchema.parse(input);
  const rawOutput = await node.fn(validatedInput, ctx);
  return node.outputSchema.parse(rawOutput);
}
