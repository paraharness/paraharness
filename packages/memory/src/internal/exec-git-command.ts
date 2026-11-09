import { execFile } from 'node:child_process';
import { GIT_COMMAND_TIMEOUT_MS } from './memory-protocol.constants.js';

/**
 * Execution options and result shape for `execGitCommand`.
 */
export interface ExecGitCommandOptions {
  /** Working directory or `-C` target directory for the git invocation. */
  readonly cwd: string;
  /** Positional git CLI arguments following `-C <cwd>`. */
  readonly args: readonly string[];
  /** Optional timeout in milliseconds (defaults to `GIT_COMMAND_TIMEOUT_MS`). */
  readonly timeoutMs?: number;
  /** Whether to prepend `-C <cwd>` automatically (defaults to `true`). */
  readonly useDashC?: boolean;
  /** Structured result captured from the git process. */
  readonly resultShape?: {
    /** Exit status code (`0` on success). */
    readonly exitCode: number;
    /** Captured UTF-8 standard output. */
    readonly stdout: string;
    /** Captured UTF-8 standard error. */
    readonly stderr: string;
  };
}

/**
 * Spawns `git` without a shell and resolves with `{ exitCode, stdout, stderr }` without rejecting on
 * non-zero exit codes so callers can inspect exit statuses deterministically.
 *
 * @param {ExecGitCommandOptions} options - Target directory, arguments, and optional timeout.
 *
 * @returns {Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>} Captured exit code, stdout, and stderr.
 */
export function execGitCommand(options: ExecGitCommandOptions): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const fullArgs =
    options.useDashC === false ? [...options.args] : ['-C', options.cwd, ...options.args];
  return new Promise((resolve) => {
    execFile(
      'git',
      fullArgs,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve(
            Object.freeze({
              exitCode: 0,
              stdout,
              stderr,
            }),
          );
          return;
        }
        const rawCode = (err as NodeJS.ErrnoException & { readonly code?: number | string }).code;
        const exitCode = typeof rawCode === 'number' ? rawCode : 1;
        resolve(
          Object.freeze({
            exitCode,
            stdout: stdout ?? '',
            stderr: stderr || err.message,
          }),
        );
      },
    );
  });
}
