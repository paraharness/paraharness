import type { ChildProcess } from 'node:child_process';
import type { LocalDaemonRegexDescriptor } from '../../builders/local-daemon-builder.js';
import { waitForTcpPortReady } from './daemon-ports-and-scope-key.js';
import { waitForDaemonStdoutPattern } from './wait-for-daemon-stdout-pattern.js';

/**
 * Parameters for verifying daemon readiness across combined `stdout`/`stderr` and allocated TCP ports.
 *
 * Supplies the spawned daemon child process, optional readiness regex, allocated ports map, and service ID.
 */
export interface WaitForDaemonReadinessParams {
  /** Spawned daemon child process. */
  readonly child: ChildProcess;
  /** Optional readiness regex descriptor evaluated over combined `stdout` and `stderr`. */
  readonly readyWhenStdoutRegex: LocalDaemonRegexDescriptor | undefined;
  /** Allocated dynamic TCP port numbers keyed by `.port(name)`. */
  readonly ports: Readonly<Record<string, number>>;
  /** Daemon service identifier for diagnostic messages. */
  readonly serviceId: string;
}

/**
 * Verifies that a newly spawned daemon satisfies both `.readyWhenStdout` and TCP listener readiness on all ports.
 *
 * Evaluates `params.readyWhenStdoutRegex` across combined `stdout`/`stderr` first, then polls each
 * allocated port in `params.ports` via `waitForTcpPortReady`.
 *
 * @param {WaitForDaemonReadinessParams} params - Daemon child, readiness regex, allocated ports, and service ID.
 *
 * @returns {Promise<void>} Resolves once both stdout readiness and all TCP port listeners succeed.
 *
 * @throws {Error} If the daemon exits prematurely or readiness verification times out.
 */
export async function waitForDaemonReadiness(
  params: WaitForDaemonReadinessParams,
): Promise<void> {
  await waitForDaemonStdoutPattern({
    child: params.child,
    readyRegexDesc: params.readyWhenStdoutRegex,
    serviceId: params.serviceId,
  });
  for (const port of Object.values(params.ports)) {
    await waitForTcpPortReady(port);
  }
}
