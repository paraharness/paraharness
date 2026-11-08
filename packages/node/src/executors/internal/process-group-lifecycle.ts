import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { EnvRef } from '@paraharness/core';
import fkill from 'fkill';
import pidtree from 'pidtree';
import {
  DEFAULT_SUBPROCESS_GRACE_MS,
  ISOLATED_GIT_ENV_OVERRIDES,
} from '../node-subprocess-env.constants.js';
import { resolveConfiguredEnvVars } from './resolve-configured-env-vars.js';
import {
  sendProcessSignalBestEffort,
  waitForPidTreeExit,
} from './wait-for-pid-tree-exit.js';

/**
 * Resolved working directory and environment variable map for spawning a local subprocess.
 *
 * Returned by `resolveWorktreeEnvAndCwd` after inspecting the active scope handle and resolving `EnvRef` entries.
 */
export interface ResolvedSubprocessEnvironment {
  /** Working directory for the spawned subprocess (`worktreePath` or `process.cwd()`). */
  readonly cwd: string;
  /** Resolved environment variables including any isolated `GIT_*` overrides. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Extracted `worktreePath` from the scope handle when present. */
  readonly worktreePath?: string;
}

/**
 * Parameters for spawning a detached OS subprocess group via `spawnDetachedSubprocess`.
 *
 * Bundles the command `argv`, resolved environment and `cwd`, and standard I/O descriptor configuration.
 */
export interface SpawnDetachedSubprocessParams {
  /** Non-empty command argument vector where index `0` is the executable. */
  readonly argv: readonly string[];
  /** Resolved working directory and environment variables. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
  /** Standard input mode (`'ignore'` for closed stdin or `'pipe'` for writable stdin). */
  readonly stdinStdio?: 'ignore' | 'pipe';
}

/**
 * Extracts a normalized absolute `worktreePath` from `scopeHandle` when present and non-empty.
 *
 * Narrows `scopeHandle` safely without type casts.
 *
 * @param {unknown} scopeHandle - Candidate isolation scope handle.
 *
 * @returns {string | undefined} Resolved worktree path, or `undefined` if absent.
 */
function extractScopeWorktreePath(scopeHandle: unknown): string | undefined {
  if (
    typeof scopeHandle === 'object' &&
    scopeHandle !== null &&
    'worktreePath' in scopeHandle &&
    typeof scopeHandle.worktreePath === 'string' &&
    scopeHandle.worktreePath.length > 0
  ) {
    return path.resolve(scopeHandle.worktreePath);
  }
  return undefined;
}

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
  const worktreePath = extractScopeWorktreePath(scopeHandle);
  const cwd = worktreePath ?? process.cwd();
  const env: Record<string, string | undefined> =
    worktreePath !== undefined
      ? {
          ...process.env,
          ...ISOLATED_GIT_ENV_OVERRIDES,
          GIT_CEILING_DIRECTORIES: path.dirname(worktreePath),
        }
      : { ...process.env };
  resolveConfiguredEnvVars({ envConfig, resolveEnv, targetEnv: env });
  return Object.freeze<ResolvedSubprocessEnvironment>({
    cwd,
    env: Object.freeze(env),
    worktreePath,
  });
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
  sendProcessSignalBestEffort(-pid, 'SIGTERM');
  await fkill([...trackedPids], { force: false, silent: true }).catch(() => undefined);
  await waitForPidTreeExit(trackedPids, graceMs);
  const remainingTree = await pidtree(pid, { root: true }).catch(() => []);
  for (const childPid of remainingTree) {
    trackedPids.add(childPid);
  }
  sendProcessSignalBestEffort(-pid, 'SIGKILL');
  await fkill([...trackedPids], { force: true, silent: true }).catch(() => undefined);
  await waitForPidTreeExit(trackedPids, graceMs);
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
  if (child.pid === undefined) {
    return;
  }
  await terminatePidTreeWithGrace(child.pid, graceMs);
}
