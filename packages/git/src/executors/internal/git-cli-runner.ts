import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@harness-dsl/lockfile';
import writeFileAtomic from 'write-file-atomic';
import {
  HarnessMetaSchema,
  type HarnessMetaRecord,
} from '../../schemas/git-receipts.schema.js';
import type { GitCliCommandOptions } from './git-cli-command-options.js';
import type { GitCliCommandResult } from './git-cli-command-result.js';
import { HARNESS_GIT_IDENTITY_ENV } from './git-executor.constants.js';

/**
 * Constructs the isolated environment map for git and subprocess invocations inside a worktree.
 *
 * Sets `GIT_CEILING_DIRECTORIES=<dirname(worktreePath)>`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`,
 * disables GPG signing, and forces `core.hooksPath=/dev/null` per `SPEC.md` §4.4.
 *
 * @param {string}                                       worktreePath - Worktree directory path.
 * @param {Readonly<Record<string, string | undefined>>} [extraEnv]   - Optional overrides merged on top.
 *
 * @returns {Readonly<Record<string, string>>} Frozen environment map for subprocess execution.
 */
export function buildIsolatedWorktreeGitEnv(
  worktreePath: string,
  extraEnv?: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, HARNESS_GIT_IDENTITY_ENV, {
    GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(worktreePath)),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath',
    GIT_CONFIG_VALUE_1: '/dev/null',
  });
  if (extraEnv !== undefined) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value !== undefined) env[key] = value;
    }
  }
  return Object.freeze(env);
}

/**
 * Spawns a `git` CLI command inside `options.cwd` with isolated worktree environment settings.
 *
 * Pipes optional `stdin`, captures `stdoutBuffer` and `stderr`, cleans up `AbortSignal` listeners,
 * and throws an actionable diagnostic `Error` when `exitCode !== 0` unless `allowNonZeroExit` is set.
 *
 * @param {GitCliCommandOptions} options - Command execution options.
 *
 * @returns {Promise<GitCliCommandResult>} Resolved exit code, decoded output strings, and raw stdout buffer.
 *
 * @throws {Error} If the `git` process exits non-zero and `allowNonZeroExit` is not `true`.
 */
export async function runGitCommand(
  options: GitCliCommandOptions,
): Promise<GitCliCommandResult> {
  options.signal?.throwIfAborted();
  const env = buildIsolatedWorktreeGitEnv(options.cwd, options.env);
  return new Promise<GitCliCommandResult>((resolve, reject) => {
    const child = spawn('git', [...options.args], { cwd: options.cwd, env, stdio: 'pipe' });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (err: Error) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code: number | null) => {
      options.signal?.removeEventListener('abort', onAbort);
      const exitCode = code ?? 1;
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stdout = stdoutBuffer.toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (exitCode !== 0 && !options.allowNonZeroExit) {
        reject(new Error(`git ${options.args.join(' ')} failed in '${options.cwd}' (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ exitCode, stdout, stderr, stdoutBuffer });
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

/**
 * Reads and validates `<gitDirPath>/harness-meta.json` using `HarnessMetaSchema`.
 *
 * Parses the persisted worktree lineage, unresolved conflict digests, and in-flight crash-recovery markers.
 *
 * @param {string} gitDirPath - Path to the worktree's isolated `<gitdir>` metadata directory.
 *
 * @returns {Promise<HarnessMetaRecord>} Validated `HarnessMetaRecord` object.
 */
export async function readHarnessMeta(gitDirPath: string): Promise<HarnessMetaRecord> {
  const metaPath = path.join(gitDirPath, 'harness-meta.json');
  const rawJson = await readFile(metaPath, 'utf8');
  return HarnessMetaSchema.parse(JSON.parse(rawJson));
}

/**
 * Atomically writes and validates `<gitDirPath>/harness-meta.json` under a cross-process file lock.
 *
 * Acquires `<gitDirPath>/harness-meta.json.lock` via `withFileLock` and persists the validated JSON via `writeFileAtomic`.
 *
 * @param {string}            gitDirPath - Path to the worktree's isolated `<gitdir>` metadata directory.
 * @param {HarnessMetaRecord} meta       - Metadata record to persist.
 *
 * @returns {Promise<void>} Resolves once `harness-meta.json` is durably updated.
 */
export async function writeHarnessMeta(
  gitDirPath: string,
  meta: HarnessMetaRecord,
): Promise<void> {
  const validated = HarnessMetaSchema.parse(meta);
  const metaPath = path.join(gitDirPath, 'harness-meta.json');
  const lockPath = path.join(gitDirPath, 'harness-meta.json.lock');
  await withFileLock(lockPath, async () => {
    await writeFileAtomic(metaPath, JSON.stringify(validated, null, 2), { encoding: 'utf8' });
  });
}
