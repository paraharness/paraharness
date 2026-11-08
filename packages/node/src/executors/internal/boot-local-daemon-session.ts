import type { ChildProcess } from 'node:child_process';
import type { LocalServiceNode, ServiceSession } from '@metaharness/core';
import type { LocalDaemonCommandContext } from '../../builders/local-daemon-builder.js';
import { createActiveDaemonSession } from './create-active-daemon-session.js';
import {
  allocateDynamicPorts,
  sanitizeDaemonScopeKey,
} from './daemon-ports-and-scope-key.js';
import {
  spawnDetachedSubprocess,
  type ResolvedSubprocessEnvironment,
} from './process-group-lifecycle.js';
import { runBestEffortStopCommand } from './run-best-effort-stop-command.js';
import { teardownDaemonProcessAndPorts } from './teardown-daemon-process-and-ports.js';
import { waitForDaemonReadiness } from './wait-for-daemon-readiness.js';

/**
 * Parameters for booting a `LocalServiceNode` daemon session inside a runner's daemon slot.
 *
 * Supplies the passive service AST node, raw scope key, resolved worktree environment, and slot release callback.
 */
export interface BootLocalDaemonSessionParams {
  /** Passive daemon service AST node to start. */
  readonly node: LocalServiceNode;
  /** Raw isolation scope key (`ServiceStartInput.scopeKey`) to sanitize. */
  readonly rawScopeKey: string;
  /** Resolved worktree directory and environment variables. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
  /** Callback releasing the runner's `maxDaemons` concurrency slot when the session stops. */
  readonly releaseDaemonSlot: () => void;
}

/**
 * Boots the daemon process, verifies stdout and TCP port readiness, and constructs the `ServiceSession`.
 *
 * Releases leased ports and cleans up the daemon process group if startup fails.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {BootLocalDaemonSessionParams} params - Daemon node, raw scope key, resolved environment, and slot release callback.
 *
 * @returns {Promise<ServiceSession<THandle>>} Live daemon `ServiceSession`.
 *
 * @throws {Error} If port allocation, process spawn, or readiness verification fails.
 */
export async function bootLocalDaemonSession<THandle = unknown>(
  params: BootLocalDaemonSessionParams,
): Promise<ServiceSession<THandle>> {
  const { node, rawScopeKey, resolvedEnv, releaseDaemonSlot } = params;
  const scopeKey = sanitizeDaemonScopeKey(rawScopeKey);
  const ports = await allocateDynamicPorts(node.ports);
  const cmdCtx: LocalDaemonCommandContext = {
    ports,
    scopeKey,
    worktreePath: resolvedEnv.worktreePath,
  };
  let daemonChild: ChildProcess | undefined;
  try {
    await runBestEffortStopCommand(node.stopArgv?.(cmdCtx), resolvedEnv);
    daemonChild = spawnDetachedSubprocess({ argv: node.startArgv(cmdCtx), resolvedEnv });
    daemonChild.on('error', () => {});
    await waitForDaemonReadiness({
      child: daemonChild,
      readyWhenStdoutRegex: node.readyWhenStdoutRegex,
      ports,
      serviceId: node.id,
    });
  } catch (error) {
    await teardownDaemonProcessAndPorts({
      stopArgv: node.stopArgv?.(cmdCtx),
      resolvedEnv,
      daemonChild,
      ports,
    });
    throw error;
  }
  return createActiveDaemonSession<THandle>({
    node,
    cmdCtx,
    resolvedEnv,
    daemonChild,
    releaseDaemonSlot,
  });
}
