import type {
  LocalCommandNode,
  StepExecutionContext,
} from '@harness-dsl/core';

/**
 * Parameters for evaluating a command's `.unrepeatable(preCheckCmd, { key })` guard.
 *
 * Supplies the passive command AST node, schema-validated input payload, active step execution context,
 * and callback for executing the boolean pre-check command.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface ShouldSkipUnrepeatableCommandParams<TIn, TOut, THandle> {
  /** Command AST node being executed. */
  readonly node: LocalCommandNode<TIn, TOut, THandle>;
  /** Schema-validated input payload. */
  readonly validatedInput: TIn;
  /** Active step execution context. */
  readonly ctx: StepExecutionContext<THandle>;
  /** Callback executing the boolean pre-check command. */
  readonly runPreCheck: (
    preCheckCmd: LocalCommandNode<unknown, boolean, THandle>,
    input: TIn,
    ctx: StepExecutionContext<THandle>,
  ) => Promise<boolean>;
}

/**
 * Evaluates a command's `.unrepeatable(preCheckCmd, { key })` guard and returns `true` when execution should be skipped.
 *
 * Validates that the derived idempotency key is non-empty before invoking `params.runPreCheck(preCheckCmd, validatedInput, ctx)`.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {ShouldSkipUnrepeatableCommandParams<TIn, TOut, THandle>} params - Command node, validated input, step context, and pre-check runner.
 *
 * @returns {Promise<boolean>} True when `node.unrepeatable` is configured and `preCheckCmd` returns `true`.
 *
 * @throws {Error} If the evaluated idempotency key is empty or whitespace-only, or if `runPreCheck` fails.
 */
export async function shouldSkipUnrepeatableCommand<TIn, TOut, THandle>(
  params: ShouldSkipUnrepeatableCommandParams<TIn, TOut, THandle>,
): Promise<boolean> {
  const { node, validatedInput, ctx, runPreCheck } = params;
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
  const alreadyCompleted = await runPreCheck(node.unrepeatable.preCheckCmd, validatedInput, ctx);
  return alreadyCompleted === true;
}
