import { createHash } from 'node:crypto';
import getPort from 'get-port';
import waitOn from 'wait-on';
import {
  ACTIVE_LEASED_DAEMON_PORTS,
  DEFAULT_DAEMON_PORT_READY_TIMEOUT_MS,
} from '../node-subprocess-env.constants.js';

/**
 * Sanitizes a raw isolation `scopeKey` into a collision-free daemon container/resource identifier.
 *
 * Replaces characters outside `[a-zA-Z0-9_.-]` with `_` and appends a deterministic 8-hex-character
 * SHA-256 suffix of the raw unsanitized `scopeKey` (`${sanitizedPrefix}-${sha256(rawScopeKey).slice(0, 8)}`).
 *
 * @param {string} rawScopeKey - Unsanitized scope key (`${runId}:${forkId ?? 'root'}`).
 *
 * @returns {string} Collision-free sanitized scope key.
 */
export function sanitizeDaemonScopeKey(rawScopeKey: string): string {
  const sanitizedPrefix = rawScopeKey.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const digestPrefix = createHash('sha256').update(rawScopeKey, 'utf8').digest('hex').slice(0, 8);
  return `${sanitizedPrefix}-${digestPrefix}`;
}

/**
 * Allocates a single unused TCP port on `127.0.0.1` and reserves it in `ACTIVE_LEASED_DAEMON_PORTS`.
 *
 * Retries up to 25 times if a concurrent in-process reservation claims the same ephemeral port.
 *
 * @param {string} portName - Logical port name for error diagnostics.
 *
 * @returns {Promise<number>} Reserved conflict-free TCP port number.
 *
 * @throws {Error} If a conflict-free TCP port cannot be allocated after 25 attempts.
 */
async function allocateSingleDynamicPort(portName: string): Promise<number> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const probed = await getPort({ host: '127.0.0.1', exclude: ACTIVE_LEASED_DAEMON_PORTS });
    if (!ACTIVE_LEASED_DAEMON_PORTS.has(probed)) {
      ACTIVE_LEASED_DAEMON_PORTS.add(probed);
      return probed;
    }
  }
  throw new Error(`Failed to allocate conflict-free TCP port for '${portName}'.`);
}

/**
 * Allocates distinct, conflict-free dynamic TCP ports for all named `.port(name)` entries on a daemon.
 *
 * Uses `getPort` combined with the in-process `ACTIVE_LEASED_DAEMON_PORTS` reservation set so concurrent
 * daemon startups before socket bind never collide on the same ephemeral port.
 *
 * @param {readonly string[]} portNames - Declared port names on `LocalServiceNode`.
 *
 * @returns {Promise<Readonly<Record<string, number>>>} Frozen map from port name to allocated TCP port.
 *
 * @throws {Error} If any declared port cannot be allocated conflict-free.
 */
export async function allocateDynamicPorts(
  portNames: readonly string[],
): Promise<Readonly<Record<string, number>>> {
  const allocated: Record<string, number> = {};
  try {
    for (const name of portNames) {
      allocated[name] = await allocateSingleDynamicPort(name);
    }
    return Object.freeze(allocated);
  } catch (error) {
    for (const port of Object.values(allocated)) {
      ACTIVE_LEASED_DAEMON_PORTS.delete(port);
    }
    throw error;
  }
}

/**
 * Waits for `127.0.0.1:port` to accept TCP connections via `wait-on` or rejects on timeout/abort.
 *
 * Verifies that a daemon's declared `.port()` socket is actively listening before resolving service startup.
 *
 * @param {number}      port              - Target TCP port number on `127.0.0.1`.
 * @param {number}      [timeoutMs=10000] - Maximum wait duration in milliseconds.
 * @param {AbortSignal} [signal]          - Optional abort signal cancelling readiness polling.
 *
 * @returns {Promise<void>} Resolves once a TCP connection to `port` succeeds.
 *
 * @throws {Error} If `signal` aborts or `port` does not accept connections within `timeoutMs`.
 */
export async function waitForTcpPortReady(
  port: number,
  timeoutMs = DEFAULT_DAEMON_PORT_READY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const waitPromise = waitOn({
    resources: [`tcp:127.0.0.1:${String(port)}`],
    timeout: timeoutMs,
    interval: 25,
  }).catch(() => {
    throw new Error(
      `Timed out after ${String(timeoutMs)}ms waiting for TCP listener on port ${String(port)}.`,
    );
  });
  if (signal === undefined) {
    await waitPromise;
    return;
  }
  const abortControl: { rejectAbort?: (reason: Error) => void } = {};
  const onAbort = (): void => {
    abortControl.rejectAbort?.(
      new Error(`Aborted while waiting for TCP listener on port ${String(port)}.`),
    );
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const abortPromise = new Promise<never>((_, reject) => {
      abortControl.rejectAbort = reject;
    });
    await Promise.race([waitPromise, abortPromise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
