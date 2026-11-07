import type { BufferedSubprocessResult } from './buffered-subprocess-result.js';
import {
  spawnDetachedSubprocess,
  terminateProcessGroupWithGrace,
} from './process-group-lifecycle.js';
import type { RunBufferedSubprocessParams } from './run-buffered-subprocess-params.js';

/**
 * Parses trimmed `stdout` from a completed `local.command` subprocess.
 *
 * Returns `undefined` when `stdout` is empty, parses valid JSON payloads via `JSON.parse`,
 * and falls back to the trimmed UTF-8 string when `stdout` is not valid JSON.
 *
 * @param {string} stdout - Raw standard output captured from the subprocess.
 *
 * @returns {unknown} Parsed JSON value, trimmed string, or `undefined`.
 */
export function parseCommandStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Spawns a detached one-shot subprocess, streams optional `stdinPayload`, and buffers `stdout` and `stderr`.
 *
 * Enforces `params.signal` (`AbortSignal`) and `params.timeoutMinutes` by terminating the entire
 * detached process group (`SIGTERM` -> `SIGKILL`) and always removes the abort listener in `finally`.
 *
 * @param {RunBufferedSubprocessParams} params - Command `argv`, environment, stdin payload, timeout, and signal.
 *
 * @returns {Promise<BufferedSubprocessResult>} Captured `exitCode`, `stdout`, and `stderr`.
 */
export async function runBufferedSubprocess(params: RunBufferedSubprocessParams): Promise<BufferedSubprocessResult> {
  params.signal?.throwIfAborted();
  const stdinStdio = params.stdinPayload !== undefined ? 'pipe' : 'ignore';
  const child = spawnDetachedSubprocess({ argv: params.argv, resolvedEnv: params.resolvedEnv, stdinStdio });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  if (params.stdinPayload !== undefined && child.stdin !== null) {
    child.stdin.on('error', () => {});
    child.stdin.end(params.stdinPayload);
  }
  let onAbort: (() => void) | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let terminatedBySignalOrTimeout = false;
  try {
    return await new Promise<BufferedSubprocessResult>((resolve, reject) => {
      const abortRun = (msg: string): void => {
        if (terminatedBySignalOrTimeout) return;
        terminatedBySignalOrTimeout = true;
        void terminateProcessGroupWithGrace(child).then(() => reject(new Error(msg)));
      };
      if (params.signal !== undefined) {
        onAbort = (): void => abortRun(`Command '${params.commandId}' aborted by AbortSignal.`);
        params.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (params.timeoutMinutes !== undefined) {
        timeoutTimer = setTimeout(() => abortRun(`Command '${params.commandId}' timed out after ${String(params.timeoutMinutes)}m.`), params.timeoutMinutes * 60_000);
      }
      child.once('error', reject);
      child.once('close', (code) => {
        if (!terminatedBySignalOrTimeout) resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8') });
      });
    });
  } finally {
    if (onAbort !== undefined && params.signal !== undefined) params.signal.removeEventListener('abort', onAbort);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
  }
}
