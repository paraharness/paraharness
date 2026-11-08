import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitWorktreeHandle, ToolEffect } from '@metaharness/core';
import type { ComputeWorktreeStatusOptions } from './compute-worktree-status-options.js';
import {
  compileWorktreeExcludeMatcher,
  computePathModeAndSha256,
} from './file-digest-and-globs.js';
import { runGitCommand } from './git-cli-runner.js';
import type { WorktreeStatusSnapshot } from './worktree-status-snapshot.js';

/**
 * Parameters for expanding a newly ignored directory or file entry (`! <relPath>`) into `statusMap`.
 */
interface CollectNewlyIgnoredFilesParams {
  /** Worktree directory path. */
  readonly worktreePath: string;
  /** Newly ignored relative path from porcelain v2. */
  readonly relPath: string;
  /** Compiled exclusion glob predicate. */
  readonly isExcluded: (candidate: string) => boolean;
  /** Mutable status map receiving discovered ignored files. */
  readonly statusMap: Record<string, string>;
}

/**
 * Expands a newly ignored directory or file entry (`! <relPath>`) into its underlying files and records their digests.
 *
 * @param {CollectNewlyIgnoredFilesParams} params - Ignored file collection parameters.
 *
 * @returns {Promise<void>} Resolves once all matching ignored files under `params.relPath` are hashed into `params.statusMap`.
 */
async function collectNewlyIgnoredFiles(
  params: CollectNewlyIgnoredFilesParams,
): Promise<void> {
  const lsFilesOutput = await runGitCommand({
    cwd: params.worktreePath,
    args: ['ls-files', '--others', '-i', '--exclude-standard', '-z', '--', params.relPath],
  });
  for (const subPath of lsFilesOutput.stdout.split('\0')) {
    if (subPath.length > 0 && !params.isExcluded(subPath)) {
      params.statusMap[subPath] = await computePathModeAndSha256(
        path.join(params.worktreePath, subPath),
      );
    }
  }
}

/**
 * Parses NUL-delimited `git status --porcelain=v2 -z --no-renames --untracked-files=all` output into `WorktreeStatusSnapshot`.
 *
 * Hashes every dirty tracked and untracked file via `computePathModeAndSha256` while filtering out `excludeGlobs`.
 *
 * @param {string}                       worktreePath - Worktree directory path.
 * @param {string}                       rawStdout    - Raw NUL-delimited stdout from `git status --porcelain=v2 -z`.
 * @param {ComputeWorktreeStatusOptions} [options]    - Optional exclusion globs and baseline ignored path set.
 *
 * @returns {Promise<WorktreeStatusSnapshot>} Parsed worktree status snapshot.
 */
export async function parsePorcelainV2Records(
  worktreePath: string,
  rawStdout: string,
  options?: ComputeWorktreeStatusOptions,
): Promise<WorktreeStatusSnapshot> {
  const isExcluded = compileWorktreeExcludeMatcher(options?.excludeGlobs);
  const statusMap: Record<string, string> = {};
  const untrackedPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  const ignoredPaths: string[] = [];
  for (const record of rawStdout.split('\0')) {
    if (record.length === 0) continue;
    if (record.startsWith('? ')) {
      const relPath = record.slice(2);
      if (isExcluded(relPath)) continue;
      untrackedPaths.add(relPath);
      statusMap[relPath] = await computePathModeAndSha256(path.join(worktreePath, relPath));
      continue;
    }
    if (record.startsWith('! ')) {
      const relPath = record.slice(2);
      ignoredPaths.push(relPath);
      if (
        options?.includeMatchingIgnored &&
        options.baselineIgnoredPaths !== undefined &&
        !options.baselineIgnoredPaths.has(relPath) &&
        !isExcluded(relPath)
      ) {
        await collectNewlyIgnoredFiles({
          worktreePath,
          relPath,
          isExcluded,
          statusMap,
        });
      }
      continue;
    }
    if (!record.startsWith('1 ') && !record.startsWith('u ')) continue;
    const spaceIdx = record.startsWith('1 ') ? nthSpaceIndex(record, 8) : nthSpaceIndex(record, 10);
    if (spaceIdx === -1) continue;
    const relPath = record.slice(spaceIdx + 1);
    if (isExcluded(relPath)) continue;
    const rawDigest = await computePathModeAndSha256(path.join(worktreePath, relPath));
    const digest = rawDigest === '040000:directory' ? 'DELETED' : rawDigest;
    statusMap[relPath] = digest;
    if (digest === 'DELETED') deletedPaths.add(relPath);
  }
  return Object.freeze({ statusMap: Object.freeze(statusMap), untrackedPaths, deletedPaths, ignoredPaths: Object.freeze(ignoredPaths) });
}

/**
 * Finds the 0-based index of the `n`-th space character in `input`.
 *
 * Used to extract repository-relative file paths containing spaces from porcelain v2 records.
 *
 * @param {string} input - Porcelain v2 record line.
 * @param {number} count - 1-based space occurrence count to locate.
 *
 * @returns {number} Character index of the `count`-th space, or `-1` if fewer spaces exist.
 */
export function nthSpaceIndex(input: string, count: number): number {
  let seen = 0;
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === ' ') {
      seen += 1;
      if (seen === count) return i;
    }
  }
  return -1;
}

/**
 * Checks whether any `.gitignore` or `**\/.gitignore` entry differs between two status maps.
 *
 * Triggers `--ignored=matching` scanning in `diffEffects` when a subprocess modifies `.gitignore`.
 *
 * @param {Readonly<Record<string, string>>} beforeMap - Baseline status map from `fromCheckpoint`.
 * @param {Readonly<Record<string, string>>} afterMap  - Current status map.
 *
 * @returns {boolean} `true` if any `.gitignore` path was added, modified, or deleted.
 */
export function hasGitignoreChanged(
  beforeMap: Readonly<Record<string, string>>,
  afterMap: Readonly<Record<string, string>>,
): boolean {
  for (const key of Object.keys(beforeMap)) {
    if ((key === '.gitignore' || key.endsWith('/.gitignore')) && beforeMap[key] !== afterMap[key]) return true;
  }
  for (const key of Object.keys(afterMap)) {
    if ((key === '.gitignore' || key.endsWith('/.gitignore')) && beforeMap[key] !== afterMap[key]) return true;
  }
  return false;
}

/**
 * Builds the `fs:effect` `ToolEffect` list from the symmetric difference of worktree paths.
 *
 * Queries `git cat-file -e <baseRef>:<path>` for `existingPathsAtBaseRef` and reads `proposedContent` for UTF-8 files.
 *
 * @param {GitWorktreeHandle} handle       - Active worktree handle.
 * @param {readonly string[]} symDiffPaths - Sorted paths in the symmetric status difference.
 *
 * @returns {Promise<readonly ToolEffect[]>} Frozen `ToolEffect` tuple (empty when `symDiffPaths` is empty).
 */
export async function buildFsDiffToolEffects(
  handle: GitWorktreeHandle,
  symDiffPaths: readonly string[],
): Promise<readonly ToolEffect[]> {
  if (symDiffPaths.length === 0) return Object.freeze([]);
  const existingPathsAtBaseRef: string[] = [];
  const proposedContent: Record<string, string> = {};
  for (const relPath of symDiffPaths) {
    const checkBase = await runGitCommand({
      cwd: handle.worktreePath,
      args: ['cat-file', '-e', `${handle.baseRef}:${relPath}`],
      allowNonZeroExit: true,
    });
    if (checkBase.exitCode === 0) existingPathsAtBaseRef.push(relPath);
    const content = await readFile(path.join(handle.worktreePath, relPath), 'utf8').catch(() => undefined);
    if (content !== undefined) proposedContent[relPath] = content;
  }
  return Object.freeze([
    Object.freeze<ToolEffect>({
      kind: 'fs:effect',
      mutatesScope: true,
      attributes: Object.freeze({
        mode: 'write',
        paths: Object.freeze([...symDiffPaths]),
        existingPathsAtBaseRef: Object.freeze(existingPathsAtBaseRef),
        proposedContent: Object.freeze(proposedContent),
      }),
    }),
  ]);
}
