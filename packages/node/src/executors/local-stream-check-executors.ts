import type {
  CheckEvaluationResult,
  LocalStreamCheckNode,
  LocalStreamCheckToolNode,
  StepExecutionContext,
  ToolDriver,
  ToolExecutionResult,
} from '@metaharness/core';
import { resolveWorktreeEnvAndCwd } from './internal/process-group-lifecycle.js';
import { runStreamingCheckSubprocess } from './internal/run-streaming-check-subprocess.js';

/**
 * Executes a `LocalStreamCheckNode` (`type: 'node:stream-check'`) inside its runner pool slot.
 *
 * Streams `stdout` and `stderr` into a combined rolling multi-line buffer and triggers early
 * process-group termination when `node.circuitBreaker` matches.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LocalStreamCheckNode<THandle>} node   - Passive stream check AST node.
 * @param {unknown}                       _input - Unused check/step input parameter.
 * @param {StepExecutionContext<THandle>} ctx    - Active step execution context.
 *
 * @returns {Promise<CheckEvaluationResult>} Check evaluation result and captured failure deficits.
 */
export async function executeLocalStreamCheck<THandle = unknown>(
  node: LocalStreamCheckNode<THandle>,
  _input: unknown,
  ctx: StepExecutionContext<THandle>,
): Promise<CheckEvaluationResult> {
  const runner = ctx.getRunner(node.runner);
  return runner.withSlot(async () => {
    const resolvedEnv = resolveWorktreeEnvAndCwd(ctx.scopeHandle, node.env, (val) =>
      ctx.resolveEnv(val),
    );
    return runStreamingCheckSubprocess({
      checkId: node.id,
      argv: node.argv,
      resolvedEnv,
      circuitBreaker: node.circuitBreaker,
      timeoutMinutes: node.timeoutMinutes,
      signal: ctx.signal,
    });
  }, ctx.signal);
}

/**
 * Creates the `ToolDriver` for `LocalStreamCheckToolNode` (`type: 'node:stream-check-tool'`).
 *
 * Omits `describeEffects` so the runtime enforces post-flight workspace diffing via
 * `CheckpointableScope.diffEffects()` for `effectTracking: 'subprocess-post-flight'`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @returns {ToolDriver<LocalStreamCheckToolNode<THandle>, THandle>} Post-flight-tracked stream check tool driver.
 */
export function createLocalStreamCheckToolDriver<THandle = unknown>(): ToolDriver<
  LocalStreamCheckToolNode<THandle>,
  THandle
> {
  return Object.freeze<ToolDriver<LocalStreamCheckToolNode<THandle>, THandle>>({
    async execute(
      node: LocalStreamCheckToolNode<THandle>,
      _args: unknown,
      ctx: StepExecutionContext<THandle>,
    ): Promise<ToolExecutionResult> {
      const result = await executeLocalStreamCheck(node.check, undefined, ctx);
      return Object.freeze<ToolExecutionResult>({
        content: JSON.stringify(result),
        isError: !result.ok,
      });
    },
  });
}
