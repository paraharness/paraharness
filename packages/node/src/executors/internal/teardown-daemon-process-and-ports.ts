import type { ChildProcess } from 'node:child_process';
import { ACTIVE_LEASED_DAEMON_PORTS } from '../node-subprocess-env.constants.js';
import {
  terminateProcessGroupWithGrace,
  type ResolvedSubprocessEnvironment,
} from './process-group-lifecycle.js';
import { runBestEffortStopCommand } from './run-best-effort-stop-command.js';

/**
 * Parameters for tearing down a daemon process group and releasing its leased TCP ports.
 *
 * Supplies the optional stop command `argv`, resolved worktree environment, optional spawned child process,
 * and leased port map.
 */
export interface TeardownDaemonProcessAndPortsParams {
  /** Optional `.stopCommand()` argument vector to execute before process-group termination. */
  readonly stopArgv?: readonly string[];
  /** Resolved worktree directory and subprocess environment variables. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
  /** Spawned detached daemon child process, if startup reached process spawn. */
  readonly daemonChild?: ChildProcess;
  /** Allocated dynamic TCP port map whose ports must be released from `ACTIVE_LEASED_DAEMON_PORTS`. */
  readonly ports: Readonly<Record<string, number>>;
}

/**
 * Releases all leased TCP ports in `ports` from `ACTIVE_LEASED_DAEMON_PORTS`.
 *
 * Called unconditionally during daemon teardown after the process tree has exited.
 *
 * @param {Readonly<Record<string, number>>} ports - Allocated dynamic TCP port map.
 */
function releaseLeasedDaemonPorts(ports: Readonly<Record<string, number>>): void {
  for (const port of Object.values(ports)) {
    ACTIVE_LEASED_DAEMON_PORTS.delete(port);
  }
}

/**
 * Executes `.stopCommand` best-effort, terminates the daemon process tree, and releases leased TCP ports.
 *
 * Uses a flat `try / finally` lifecycle so process-tree termination and port release always execute.
 *
 * @param {TeardownDaemonProcessAndPortsParams} params - Stop command argv, resolved environment, daemon process, and ports.
 *
 * @returns {Promise<void>} Resolves once the stop command, process-group termination, and port release complete.
 */
export async function teardownDaemonProcessAndPorts(
  params: TeardownDaemonProcessAndPortsParams,
): Promise<void> {
  const { stopArgv, resolvedEnv, daemonChild, ports } = params;
  try {
    await runBestEffortStopCommand(stopArgv, resolvedEnv);
    if (daemonChild !== undefined) {
      await terminateProcessGroupWithGrace(daemonChild);
    }
  } finally {
    releaseLeasedDaemonPorts(ports);
  }
}
