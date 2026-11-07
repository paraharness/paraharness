import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { EnvRef } from '@harness-dsl/core';
import fkill from 'fkill';
import pidtree from 'pidtree';
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
 * @param {unknown}                                        scopeHandle - Active isolation scope handle.
 * @param {Readonly<Record<string, string | EnvRef>>}      [envConfig] - Optional command or check environment bindings.
 * @param {(value: string | EnvRef) => string | undefined} resolveEnv  - Runtime `EnvRef` resolver callback.
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
 * Enumerates the descendant PID tree of `pid` via `pidtree` and terminates all processes via `fkill`.
 *
 * Sends `SIGTERM` across the descendant PID tree and process group (`-pid`), waits up to `graceMs`
 * if any descendant remains alive, and escalates to `fkill(..., { force: true, silent: true })`.
 *
 * @param {number} pid           - Root process ID to terminate along with all descendants.
 * @param {number} [graceMs=200] - Grace window in milliseconds before escalating to `SIGKILL`.
 *
 * @returns {Promise<void>} Resolves once the process tree and process group have exited.
 */
export async function terminatePidTreeWithGrace(
  pid: number,
  graceMs = DEFAULT_SUBPROCESS_GRACE_MS,
): Promise<void> {
  const initialTree = await pidtree(pid, { root: true }).catch(() => [pid]);
  const trackedPids = new Set<number>([pid, ...initialTree]);
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {}
  await fkill([...trackedPids], { force: false, silent: true }).catch(() => undefined);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    let anyAlive = false;
    for (const candidatePid of trackedPids) {
      try {
        process.kill(candidatePid, 0);
        anyAlive = true;
        break;
      } catch {}
    }
    if (!anyAlive) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  }
  const remainingTree = await pidtree(pid, { root: true }).catch(() => []);
  for (const childPid of remainingTree) trackedPids.add(childPid);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
  await fkill([...trackedPids], { force: true, silent: true }).catch(() => undefined);
}

/**
 * Terminates a detached child process group and descendant PID tree gracefully (`pidtree` + `fkill`).
 *
 * Delegates to `terminatePidTreeWithGrace` when `child.pid` is defined and ensures `child` has exited.
 *
 * @param {ChildProcess} child         - Detached child process to terminate.
 * @param {number}       [graceMs=200] - Milliseconds to wait after `SIGTERM` before `SIGKILL`.
 *
 * @returns {Promise<void>} Resolves once the process group and descendant tree have been terminated.
 */
export async function terminateProcessGroupWithGrace(
  child: ChildProcess,
  graceMs = DEFAULT_SUBPROCESS_GRACE_MS,
): Promise<void> {
  if (child.pid === undefined) return;
  await terminatePidTreeWithGrace(child.pid, graceMs);
}
