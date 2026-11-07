import type { ChildProcess } from 'node:child_process';
import type { LocalDaemonRegexDescriptor } from '../../builders/local-daemon-builder.js';
import { DEFAULT_DAEMON_PORT_READY_TIMEOUT_MS } from '../node-subprocess-env.constants.js';

/**
 * Parameters for waiting until a daemon child process emits output matching `readyRegexDesc`.
 *
 * Supplies the spawned daemon child process, optional readiness regex descriptor, and service ID.
 */
export interface WaitForDaemonStdoutPatternParams {
  /** Spawned daemon child process. */
  readonly child: ChildProcess;
  /** Optional readiness regex descriptor over combined `stdout` and `stderr`. */
  readonly readyRegexDesc: LocalDaemonRegexDescriptor | undefined;
  /** Daemon service identifier for error diagnostics. */
  readonly serviceId: string;
}

/**
 * Waits for a daemon child process to emit combined `stdout`/`stderr` matching `params.readyRegexDesc`.
 *
 * Evaluates the regular expression across a rolling multi-line buffer and rejects immediately if
 * the daemon exits prematurely before matching.
 *
 * @param {WaitForDaemonStdoutPatternParams} params - Daemon child process, readiness regex, and service ID.
 *
 * @returns {Promise<void>} Resolves once the readiness pattern matches or immediately if omitted.
 *
 * @throws {Error} If the daemon exits prematurely or times out before matching `readyRegexDesc`.
 */
export function waitForDaemonStdoutPattern(
  params: WaitForDaemonStdoutPatternParams,
): Promise<void> {
  const { child, readyRegexDesc, serviceId } = params;
  if (readyRegexDesc === undefined) {
    return Promise.resolve();
  }
  const regex = new RegExp(
    readyRegexDesc.pattern,
    (readyRegexDesc.flags ?? '').replace(/[gy]/g, ''),
  );
  const streamState = { rollingBuffer: '' };
  return new Promise<void>((resolve, reject) => {
    const fail = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onPrematureClose = (code: number | null): void =>
      fail(
        new Error(
          `Daemon '${serviceId}' exited prematurely (code ${String(code)}) before readyWhenStdout matched. Output: ${streamState.rollingBuffer.trim()}`,
        ),
      );
    const onChunk = (chunk: Buffer): void => {
      streamState.rollingBuffer += chunk.toString('utf8');
      regex.lastIndex = 0;
      if (!regex.test(streamState.rollingBuffer)) {
        return;
      }
      cleanup();
      resolve();
    };
    const timeoutTimer = setTimeout(
      () =>
        fail(
          new Error(
            `Daemon '${serviceId}' timed out after ${String(DEFAULT_DAEMON_PORT_READY_TIMEOUT_MS)}ms waiting for readyWhenStdout.`,
          ),
        ),
      DEFAULT_DAEMON_PORT_READY_TIMEOUT_MS,
    );
    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      child.stdout?.removeListener('data', onChunk);
      child.stderr?.removeListener('data', onChunk);
      child.removeListener('close', onPrematureClose);
      child.removeListener('error', fail);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.once('close', onPrematureClose);
    child.once('error', fail);
  });
}
