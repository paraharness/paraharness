import type {
  LocalServiceNode,
  LocalServiceToolNode,
  RuntimeDriverContext,
  ServiceSession,
  ServiceStartInput,
  StepExecutionContext,
  ToolDriver,
  ToolExecutionResult,
} from '@paraharness/core';
import { bootLocalDaemonSession } from './internal/boot-local-daemon-session.js';
import { resolveWorktreeEnvAndCwd } from './internal/process-group-lifecycle.js';

/**
 * Starts a `LocalServiceNode` (`type: 'node:service'`) inside a long-lived runner daemon slot.
 *
 * Sanitizes `input.scopeKey` with an 8-character SHA-256 suffix, runs `.stopCommand` pre-start
 * cleanup, allocates conflict-free TCP ports, verifies `.readyWhenStdout` and TCP port listeners,
 * and returns a `ServiceSession` with framed PTY interaction tools.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LocalServiceNode}           node  - Passive service AST node to start.
 * @param {ServiceStartInput<THandle>} input - Run ID, raw scope key, and active scope handle.
 * @param {RuntimeDriverContext}       ctx   - Runtime driver context providing runner pools and env resolution.
 *
 * @returns {Promise<ServiceSession<THandle>>} Active daemon service session.
 */
export async function startLocalDaemonService<THandle = unknown>(
  node: LocalServiceNode,
  input: ServiceStartInput<THandle>,
  ctx: RuntimeDriverContext,
): Promise<ServiceSession<THandle>> {
  const runner = ctx.getRunner(node.runner);
  const resolvedEnv = resolveWorktreeEnvAndCwd(input.scopeHandle, undefined, (val) =>
    ctx.resolveEnv(val),
  );
  return runner.withDaemonSlot((releaseDaemonSlot) =>
    bootLocalDaemonSession<THandle>({
      node,
      rawScopeKey: input.scopeKey,
      resolvedEnv,
      releaseDaemonSlot,
    }),
  );
}

/**
 * Creates the `ToolDriver` for `LocalServiceToolNode` (`type: 'node:service-tool'`).
 *
 * Omits `describeEffects` (`effectTracking: 'subprocess-post-flight'`) and dispatches tool calls
 * to `ctx.activeServiceSessions?.get(node.serviceId)?.invokeTool(node.name, args, ctx)`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @returns {ToolDriver<LocalServiceToolNode<THandle>, THandle>} Post-flight-tracked service tool driver.
 */
export function createLocalServiceToolDriver<THandle = unknown>(): ToolDriver<
  LocalServiceToolNode<THandle>,
  THandle
> {
  return Object.freeze<ToolDriver<LocalServiceToolNode<THandle>, THandle>>({
    async execute(
      node: LocalServiceToolNode<THandle>,
      args: unknown,
      ctx: StepExecutionContext<THandle>,
    ): Promise<ToolExecutionResult> {
      const session = ctx.activeServiceSessions?.get(node.serviceId);
      if (session === undefined) {
        throw new Error(
          `Cannot invoke service tool '${node.name}': service '${node.serviceId}' is not active in run '${ctx.runId}'.`,
        );
      }
      return session.invokeTool(node.name, args, ctx);
    },
  });
}
