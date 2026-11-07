import type {
  CheckEvaluationResult,
  LocalCommandCheckNode,
  LocalCommandNode,
  LocalCommandToolNode,
  StepExecutionContext,
  ToolDriver,
  ToolExecutionResult,
} from '@harness-dsl/core';
import { resolveWorktreeEnvAndCwd } from './internal/process-group-lifecycle.js';
import {
  parseCommandStdout,
  runBufferedSubprocess,
} from './internal/run-buffered-subprocess.js';

/**
 * Executes a `LocalCommandNode` (`type: 'node:command'`) inside its configured runner pool slot.
 *
 * Evaluates `.unrepeatable(preCheckCmd, { key })` first when present (skipping execution if `preCheckCmd`
 * returns `true`), runs the command in a detached process group with isolated `GIT_*` env vars,
 * throws an actionable error on non-zero exit codes, and validates parsed `stdout` against `node.outputSchema`.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LocalCommandNode<TIn, TOut, THandle>} node  - Passive command AST node to execute.
 * @param {TIn}                                  input - Raw or pre-validated command input payload.
 * @param {StepExecutionContext<THandle>}        ctx   - Active step execution context.
 *
 * @returns {Promise<TOut>} Validated output payload parsed from `stdout`.
 *
 * @throws {Error} If the subprocess exits with a non-zero code, times out, or is aborted.
 */
export async function executeLocalCommandStep<TIn = unknown, TOut = unknown, THandle = unknown>(
  node: LocalCommandNode<TIn, TOut, THandle>,
  input: TIn,
  ctx: StepExecutionContext<THandle>,
): Promise<TOut> {
  const validatedInput = node.inputSchema.parse(input);
  if (node.unrepeatable !== undefined) {
    const idempotencyKey = typeof node.unrepeatable.key === 'function' ? node.unrepeatable.key(validatedInput) : node.unrepeatable.key;
    if (idempotencyKey.trim().length === 0) {
      throw new Error(`Command '${node.id}' (runId '${ctx.runId}') evaluated an empty unrepeatable idempotency key.`);
    }
    const alreadyCompleted = await executeLocalCommandStep(node.unrepeatable.preCheckCmd, validatedInput, ctx);
    if (alreadyCompleted === true) return node.outputSchema.parse(undefined);
  }
  const runner = ctx.getRunner(node.runner);
  return runner.withSlot(async () => {
    const argv = typeof node.argv === 'function' ? node.argv(validatedInput) : node.argv;
    const stdinPayload = node.stdinMode === 'closed' ? undefined : node.stdinMode(validatedInput);
    const resolvedEnv = resolveWorktreeEnvAndCwd(ctx.scopeHandle, node.env, (val) => ctx.resolveEnv(val));
    const result = await runBufferedSubprocess({
      commandId: node.id,
      argv,
      resolvedEnv,
      stdinPayload,
      timeoutMinutes: node.timeoutMinutes,
      signal: ctx.signal,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Command '${node.id}' exited with code ${String(result.exitCode)}. stdout: ${result.stdout.trim()} stderr: ${result.stderr.trim()}`);
    }
    return node.outputSchema.parse(parseCommandStdout(result.stdout));
  }, ctx.signal);
}

/**
 * Executes a `LocalCommandCheckNode` (`type: 'node:command-check'`) as a deterministic check gate.
 *
 * Returns `{ ok: true, deficits: [] }` when the underlying command exits with code `0`, or captures
 * the error message as a deficit when the command fails.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LocalCommandCheckNode<THandle>} node   - Passive command check AST node.
 * @param {unknown}                        _input - Unused check input parameter.
 * @param {StepExecutionContext<THandle>}  ctx    - Active step execution context.
 *
 * @returns {Promise<CheckEvaluationResult>} Check evaluation outcome and deficit messages.
 */
export async function executeLocalCommandCheck<THandle = unknown>(
  node: LocalCommandCheckNode<THandle>,
  _input: unknown,
  ctx: StepExecutionContext<THandle>,
): Promise<CheckEvaluationResult> {
  try {
    await executeLocalCommandStep(node.command, undefined, ctx);
    return Object.freeze<CheckEvaluationResult>({ ok: true, deficits: Object.freeze([]) });
  } catch (error) {
    if (ctx.signal?.aborted === true) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze<CheckEvaluationResult>({
      ok: false,
      deficits: Object.freeze([message]),
    });
  }
}

/**
 * Creates the `ToolDriver` for `LocalCommandToolNode` (`type: 'node:command-tool'`).
 *
 * Omits `describeEffects` so the runtime enforces post-flight workspace diffing via
 * `CheckpointableScope.diffEffects()` for `effectTracking: 'subprocess-post-flight'`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @returns {ToolDriver<LocalCommandToolNode<THandle>, THandle>} Post-flight-tracked command tool driver.
 */
export function createLocalCommandToolDriver<THandle = unknown>(): ToolDriver<
  LocalCommandToolNode<THandle>,
  THandle
> {
  return Object.freeze<ToolDriver<LocalCommandToolNode<THandle>, THandle>>({
    async execute(
      node: LocalCommandToolNode<THandle>,
      args: unknown,
      ctx: StepExecutionContext<THandle>,
    ): Promise<ToolExecutionResult> {
      const validatedArgs = node.inputSchema.parse(args);
      const output = await executeLocalCommandStep(node.command, validatedArgs, ctx);
      const content =
        typeof output === 'string'
          ? output
          : output === undefined
            ? ''
            : JSON.stringify(output);
      return Object.freeze<ToolExecutionResult>({ content });
    },
  });
}
