import type { ChildProcess } from 'node:child_process';
import type {
  LocalServiceNode,
  ServiceSession,
  StepExecutionContext,
  ToolExecutionResult,
} from '@paraharness/core';
import type { LocalDaemonCommandContext } from '../../builders/local-daemon-builder.js';
import { buildServiceToolNodes } from './build-service-tool-nodes.js';
import { createPtyInteractionController } from './create-pty-interaction-controller.js';
import type { ResolvedSubprocessEnvironment } from './process-group-lifecycle.js';
import { teardownDaemonProcessAndPorts } from './teardown-daemon-process-and-ports.js';

/**
 * Parameters for constructing an active `ServiceSession` around a booted daemon process.
 *
 * Supplies the daemon AST node, command context, resolved environment, spawned process, and slot release callback.
 */
export interface CreateActiveDaemonSessionParams {
  /** Passive daemon service AST node. */
  readonly node: LocalServiceNode;
  /** Allocated dynamic ports and sanitized scope key context. */
  readonly cmdCtx: LocalDaemonCommandContext;
  /** Resolved worktree directory and subprocess environment variables. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
  /** Spawned detached daemon child process. */
  readonly daemonChild: ChildProcess;
  /** Callback releasing the runner's `maxDaemons` concurrency slot on teardown. */
  readonly releaseDaemonSlot: () => void;
}

/**
 * Constructs a frozen `ServiceSession` wrapping an active daemon child process and its `PtyInteractionController`.
 *
 * Ensures idempotent `stop()` teardown that closes all PTY sessions, executes `.stopCommand` if configured,
 * terminates the daemon process tree, releases leased TCP ports, and frees the runner daemon slot.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {CreateActiveDaemonSessionParams} params - Booted daemon session parameters.
 *
 * @returns {ServiceSession<THandle>} Frozen `ServiceSession` implementation.
 */
export function createActiveDaemonSession<THandle = unknown>(
  params: CreateActiveDaemonSessionParams,
): ServiceSession<THandle> {
  const { node, cmdCtx, resolvedEnv, daemonChild, releaseDaemonSlot } = params;
  const ptyController = createPtyInteractionController({ node, cmdCtx, resolvedEnv });
  const lifecycleState = { stopped: false };
  return Object.freeze<ServiceSession<THandle>>({
    id: node.id,
    tools: buildServiceToolNodes<THandle>(node),
    invokeTool(
      toolName: string,
      args: unknown,
      ctx: StepExecutionContext<THandle>,
    ): Promise<ToolExecutionResult> {
      return ptyController.invokeTool(toolName, args, ctx.signal);
    },
    async stop(): Promise<void> {
      if (lifecycleState.stopped) return;
      lifecycleState.stopped = true;
      try {
        await ptyController.closeAll();
      } finally {
        await teardownDaemonProcessAndPorts({
          stopArgv: node.stopArgv?.(cmdCtx),
          resolvedEnv,
          daemonChild,
          ports: cmdCtx.ports,
        }).finally(() => {
          releaseDaemonSlot();
        });
      }
    },
  });
}
