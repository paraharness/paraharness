import type {
  LocalCommandNode,
  StepExecutionContext,
} from '@harness-dsl/core';

/**
 * Evaluates a command's `.unrepeatable(preCheckCmd, { key })` guard and returns `true` when execution should be skipped.
 *
 * Validates that the derived idempotency key is non-empty before invoking `executeStep(preCheckCmd, validatedInput, ctx)`.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LocalCommandNode<TIn, TOut, THandle>} node           - Command AST node being executed.
 * @param {TIn}                                  validatedInput - Schema-validated input payload.
 * @param {StepExecutionContext<THandle>}        ctx            - Active step execution context.
 * @param {(preCheck: LocalCommandNode<unknown, boolean, THandle>, input: unknown, context: StepExecutionContext<THandle>) => Promise<boolean>} runPreCheck - Callback executing the pre-check command.
 *
 * @returns {Promise<boolean>} True when `node.unrepeatable` is configured and `preCheckCmd` returns `true`.
 *
 * @throws {Error} If the evaluated idempotency key is empty or whitespace-only.
 */
export async function shouldSkipUnrepeatableCommand<TIn, TOut, THandle>(
  node: LocalCommandNode<TIn, TOut, THandle>,
  validatedInput: TIn,
  ctx: StepExecutionContext<THandle>,
  runPreCheck?: (
    preCheck: LocalCommandNode<unknown, boolean, THandle>,
    input: unknown,
    context: StepExecutionContext<THandle>,
  ) => Promise<boolean>,
): Promise<boolean> {
  if (node.unrepeatable === undefined) {
    return false;
  }
  const idempotencyKey =
    typeof node.unrepeatable.key === 'function'
      ? node.unrepeatable.key(validatedInput)
      : node.unrepeatable.key;
  if (idempotencyKey.trim().length === 0) {
    throw new Error(
      `Command '${node.id}' (runId '${ctx.runId}') evaluated an empty unrepeatable idempotency key.`,
    );
  }
  if (runPreCheck === undefined) {
    return false;
  }
  const alreadyCompleted = await runPreCheck(node.unrepeatable.preCheckCmd, validatedInput, ctx);
  return alreadyCompleted === true;
}
