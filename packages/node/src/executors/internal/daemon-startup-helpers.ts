import type { ChildProcess } from 'node:child_process';
import type { LocalDaemonRegexDescriptor } from '../../builders/local-daemon-interact-options.js';
import { DEFAULT_DAEMON_PORT_READY_TIMEOUT_MS } from '../node-subprocess-env.constants.js';
import {
  spawnDetachedSubprocess,
  terminateProcessGroupWithGrace,
} from './process-group-lifecycle.js';
import type { ResolvedSubprocessEnvironment } from './spawn-detached-subprocess-params.js';

/**
 * Executes a daemon `.stopCommand` best-effort to reap crash-orphaned containers or processes.
 *
 * Swallows non-zero exit codes and spawn errors so pre-start or post-stop cleanup never masks
 * primary daemon lifecycle transitions.
 *
 * @param {readonly string[] | undefined} argv        - Optional stop command argument vector.
 * @param {ResolvedSubprocessEnvironment} resolvedEnv - Resolved working directory and environment variables.
 *
 * @returns {Promise<void>} Resolves once the best-effort stop command finishes or is skipped.
 */
export async function runBestEffortStopCommand(
  argv: readonly string[] | undefined,
  resolvedEnv: ResolvedSubprocessEnvironment,
): Promise<void> {
  if (argv === undefined || argv.length === 0) return;
  try {
    const child = spawnDetachedSubprocess({ argv, resolvedEnv });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void terminateProcessGroupWithGrace(child).then(resolve);
      }, 3_000);
      child.once('error', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    return;
  }
}

/**
 * Waits for a daemon child process to emit combined `stdout`/`stderr` matching `readyRegexDesc`.
 *
 * Evaluates the regular expression across a rolling multi-line buffer and rejects immediately if
 * the daemon exits prematurely before matching.
 *
 * @param {ChildProcess}                           child          - Spawned daemon child process.
 * @param {LocalDaemonRegexDescriptor | undefined} readyRegexDesc - Optional readiness regex descriptor.
 * @param {string}                                 serviceId      - Daemon service identifier for diagnostics.
 *
 * @returns {Promise<void>} Resolves once the readiness pattern matches or immediately if omitted.
 */
export function waitForDaemonStdoutReady(
  child: ChildProcess,
  readyRegexDesc: LocalDaemonRegexDescriptor | undefined,
  serviceId: string,
): Promise<void> {
  if (readyRegexDesc === undefined) return Promise.resolve();
  const regex = new RegExp(readyRegexDesc.pattern, (readyRegexDesc.flags ?? '').replace(/[gy]/g, ''));
  return new Promise<void>((resolve, reject) => {
    let rollingBuffer = '';
    const fail = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onPrematureClose = (code: number | null): void =>
      fail(new Error(`Daemon '${serviceId}' exited prematurely (code ${String(code)}) before readyWhenStdout matched. Output: ${rollingBuffer.trim()}`));
    const onChunk = (chunk: Buffer): void => {
      rollingBuffer += chunk.toString('utf8');
      regex.lastIndex = 0;
      if (!regex.test(rollingBuffer)) return;
      cleanup();
      resolve();
    };
    const timeoutTimer = setTimeout(
      () => fail(new Error(`Daemon '${serviceId}' timed out after ${String(DEFAULT_DAEMON_PORT_READY_TIMEOUT_MS)}ms waiting for readyWhenStdout.`)),
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
