import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { EnvRef } from '@harness-dsl/core';
import {
  DEFAULT_SUBPROCESS_GRACE_MS,
  ISOLATED_GIT_ENV_OVERRIDES,
} from '../node-subprocess-env.constants.js';
import type {
  ResolvedSubprocessEnvironment,
  SpawnDetachedSubprocessParams,
} from './spawn-detached-subprocess-params.js';

/**
 * Resolves the subprocess working directory and environment map from the active `scopeHandle` and `envConfig`.
 *
 * Injects `cwd: worktreePath` and all 9 isolated `GIT_*` environment variables when `scopeHandle` exposes
 * a non-empty `worktreePath`, and resolves symbolic `EnvRef` entries via `resolveEnv`.
 *
 * @param {unknown}                                           scopeHandle - Active isolation scope handle.
 * @param {Readonly<Record<string, string | EnvRef>>}         [envConfig] - Optional command or check environment bindings.
 * @param {(value: string | EnvRef) => string | undefined}    resolveEnv  - Runtime `EnvRef` resolver callback.
 *
 * @returns {ResolvedSubprocessEnvironment} Resolved `cwd`, `env`, and optional `worktreePath`.
 *
 * @throws {Error} If a symbolic `EnvRef` resolves to `undefined` or an empty string.
 */
export function resolveWorktreeEnvAndCwd(
  scopeHandle: unknown,
  envConfig: Readonly<Record<string, string | EnvRef>> | undefined,
  resolveEnv: (value: string | EnvRef) => string | undefined,
): ResolvedSubprocessEnvironment {
  const worktreePath =
    typeof scopeHandle === 'object' &&
    scopeHandle !== null &&
    'worktreePath' in scopeHandle &&
    typeof scopeHandle.worktreePath === 'string' &&
    scopeHandle.worktreePath.length > 0
      ? path.resolve(scopeHandle.worktreePath)
      : undefined;
  const cwd = worktreePath ?? process.cwd();
  const env: Record<string, string | undefined> =
    worktreePath !== undefined
      ? { ...process.env, ...ISOLATED_GIT_ENV_OVERRIDES, GIT_CEILING_DIRECTORIES: path.dirname(worktreePath) }
      : { ...process.env };
  if (envConfig !== undefined) {
    for (const [key, rawVal] of Object.entries(envConfig)) {
      const resolved = resolveEnv(rawVal);
      if (typeof rawVal === 'object' && rawVal !== null && 'type' in rawVal && rawVal.type === 'harness:env-ref') {
        if (resolved === undefined || resolved.length === 0) {
          throw new Error(`Required environment variable '${rawVal.key}' referenced by H.env('${rawVal.key}') is not set.`);
        }
      }
      env[key] = resolved ?? '';
    }
  }
  return Object.freeze<ResolvedSubprocessEnvironment>({ cwd, env: Object.freeze(env), worktreePath });
}

/**
 * Spawns a detached OS subprocess group (`detached: true`) with piped `stdout` and `stderr`.
 *
 * Places the child process in its own process group (`-pid`) so `terminateProcessGroupWithGrace`
 * can reap the entire descendant tree on timeout or abort.
 *
 * @param {SpawnDetachedSubprocessParams} params - Subprocess `argv`, resolved environment, and stdin mode.
 *
 * @returns {ChildProcess} Spawned detached child process handle.
 *
 * @throws {Error} If `params.argv` is empty.
 */
export function spawnDetachedSubprocess(params: SpawnDetachedSubprocessParams): ChildProcess {
  const executable = params.argv[0];
  if (executable === undefined || executable.trim().length === 0) {
    throw new Error('Cannot spawn subprocess: argv[0] executable is missing or empty.');
  }
  return spawn(executable, params.argv.slice(1), {
    cwd: params.resolvedEnv.cwd,
    env: { ...params.resolvedEnv.env },
    detached: true,
    stdio: [params.stdinStdio ?? 'ignore', 'pipe', 'pipe'],
  });
}

/**
 * Sends a POSIX signal to the detached process group (`-child.pid`) with a single-process fallback.
 *
 * Swallows `ESRCH` when the process group has already exited cleanly.
 *
 * @param {ChildProcess}   child  - Target detached child process.
 * @param {NodeJS.Signals} signal - Signal to deliver (`'SIGTERM'` or `'SIGKILL'`).
 */
export function sendProcessGroupSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      try {
        child.kill(signal);
      } catch {
        return;
      }
    }
  }
}

/**
 * Terminates a detached child process group gracefully (`SIGTERM` followed by `SIGKILL` after `graceMs`).
 *
 * Resolves as soon as the child process exits or after `SIGKILL` has been delivered.
 *
 * @param {ChildProcess} child                 - Detached child process to terminate.
 * @param {number}       [graceMs=200]         - Milliseconds to wait after `SIGTERM` before `SIGKILL`.
 *
 * @returns {Promise<void>} Resolves once the process group has been terminated.
 */
export function terminateProcessGroupWithGrace(
  child: ChildProcess,
  graceMs = DEFAULT_SUBPROCESS_GRACE_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      resolve();
    };
    child.once('exit', finish);
    child.once('close', finish);
    sendProcessGroupSignal(child, 'SIGTERM');
    killTimer = setTimeout(() => {
      sendProcessGroupSignal(child, 'SIGKILL');
      fallbackTimer = setTimeout(finish, 50);
    }, graceMs);
  });
}
