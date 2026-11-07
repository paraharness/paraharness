import type { CapturedCommandResult } from './captured-command-result.js';
import {
  spawnDetachedSubprocess,
  terminateProcessGroupWithGrace,
  type ResolvedSubprocessEnvironment,
} from './process-group-lifecycle.js';

/**
 * Parameters for executing a captured one-shot subprocess via `spawnCapturedCommand`.
 *
 * Supplies the command identifier, argument vector, resolved environment, optional stdin payload,
 * timeout duration, and abort signal.
 */
export interface SpawnCapturedCommandParams {
  /** Logical identifier of the command for diagnostic error messages. */
  readonly commandId: string;
  /** Command argument vector where index `0` is the executable. */
  readonly argv: readonly string[];
  /** Resolved working directory and environment variables. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
  /** Optional standard input payload written before closing stdin. */
  readonly stdinPayload?: string | Uint8Array;
  /** Optional execution timeout in minutes. */
  readonly timeoutMinutes?: number;
  /** Optional abort signal cancelling subprocess execution. */
  readonly signal?: AbortSignal;
}

/**
 * Spawns a detached one-shot subprocess, writes optional `stdinPayload`, and captures `stdout` and `stderr`.
 *
 * Enforces `params.signal` (`AbortSignal`) and `params.timeoutMinutes` by terminating the entire
 * detached process group (`SIGTERM` -> `SIGKILL`) and always removes the abort listener and timeout
 * timer in `finally`.
 *
 * @param {SpawnCapturedCommandParams} params - Command `argv`, environment, stdin payload, timeout, and signal.
 *
 * @returns {Promise<CapturedCommandResult>} Captured `exitCode`, `stdout`, and `stderr`.
 *
 * @throws {Error} If `params.signal` aborts, the command times out, or spawning fails.
 */
export async function spawnCapturedCommand(
  params: SpawnCapturedCommandParams,
): Promise<CapturedCommandResult> {
  params.signal?.throwIfAborted();
  const stdinStdio = params.stdinPayload !== undefined ? 'pipe' : 'ignore';
  const child = spawnDetachedSubprocess({
    argv: params.argv,
    resolvedEnv: params.resolvedEnv,
    stdinStdio,
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  if (params.stdinPayload !== undefined && child.stdin !== null) {
    child.stdin.on('error', () => undefined);
    child.stdin.end(params.stdinPayload);
  }
  const runState: {
    terminated: boolean;
    timeoutTimer?: ReturnType<typeof setTimeout>;
    abortWithMessage?: (msg: string) => void;
  } = { terminated: false };
  const onAbort = (): void => {
    runState.abortWithMessage?.(`Command '${params.commandId}' aborted by AbortSignal.`);
  };
  params.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await new Promise<CapturedCommandResult>((resolve, reject) => {
      runState.abortWithMessage = (msg: string): void => {
        if (runState.terminated) return;
        runState.terminated = true;
        void terminateProcessGroupWithGrace(child).then(() => reject(new Error(msg)));
      };
      if (params.timeoutMinutes !== undefined) {
        runState.timeoutTimer = setTimeout(
          () =>
            runState.abortWithMessage?.(
              `Command '${params.commandId}' timed out after ${String(params.timeoutMinutes)}m.`,
            ),
          params.timeoutMinutes * 60_000,
        );
      }
      child.once('error', reject);
      child.once('close', (code) => {
        if (runState.terminated) return;
        resolve(
          Object.freeze<CapturedCommandResult>({
            exitCode: code ?? 1,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
          }),
        );
      });
    });
  } finally {
    params.signal?.removeEventListener('abort', onAbort);
    if (runState.timeoutTimer !== undefined) clearTimeout(runState.timeoutTimer);
  }
}
