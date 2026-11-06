import { createHash } from 'node:crypto';
import net from 'node:net';
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
 * Probes the OS kernel for a single available ephemeral TCP port on `127.0.0.1`.
 *
 * Binds an ephemeral `net.Server` to port `0`, reads the assigned port, and closes the probe socket.
 *
 * @returns {Promise<number>} Ephemeral TCP port number.
 */
export function probeSingleEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      server.close((err) => {
        if (err !== undefined && err !== null) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

/**
 * Allocates distinct, conflict-free dynamic TCP ports for all named `.port(name)` entries on a daemon.
 *
 * Tracks allocated ports in `ACTIVE_LEASED_DAEMON_PORTS` until the daemon stops so concurrent
 * daemon startups never collide on the same ephemeral port.
 *
 * @param {readonly string[]} portNames - Declared port names on `LocalServiceNode`.
 *
 * @returns {Promise<Readonly<Record<string, number>>>} Frozen map from port name to allocated TCP port.
 */
export async function allocateDynamicPorts(
  portNames: readonly string[],
): Promise<Readonly<Record<string, number>>> {
  const allocated: Record<string, number> = {};
  for (const name of portNames) {
    let candidate = 0;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const probed = await probeSingleEphemeralPort();
      if (!ACTIVE_LEASED_DAEMON_PORTS.has(probed)) {
        candidate = probed;
        ACTIVE_LEASED_DAEMON_PORTS.add(probed);
        break;
      }
    }
    if (candidate === 0) {
      throw new Error(`Failed to allocate conflict-free TCP port for '${name}'.`);
    }
    allocated[name] = candidate;
  }
  return Object.freeze(allocated);
}

/**
 * Polls `127.0.0.1:port` until a TCP listener accepts connections or `timeoutMs` expires.
 *
 * Verifies that a daemon's declared `.port()` socket is actively listening before resolving service startup.
 *
 * @param {number}      port                     - Target TCP port number on `127.0.0.1`.
 * @param {number}      [timeoutMs=10000]        - Maximum wait duration in milliseconds.
 * @param {AbortSignal} [signal]                 - Optional abort signal cancelling readiness polling.
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    signal?.throwIfAborted();
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for TCP listener on port ${String(port)}.`);
}
