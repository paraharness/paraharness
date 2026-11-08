import { randomUUID } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { GitWorktreeHandle } from '@paraharness/core';
import type { HarnessMetaRecord } from '../../schemas/git-receipts.schema.js';
import type {
  GitCheckpointPayload,
  OversizedUntrackedBlobRecord,
} from '../git-checkpoint-payload.js';
import {
  computeNodeModulesDigest,
  copyFileCowOrValue,
} from './file-digest-and-globs.js';
import { readHarnessMeta, runGitCommand } from './git-cli-runner.js';
import type { StagedCheckpointTreeResult } from './staged-checkpoint-tree-result.js';
import type { WorktreeIntegrityVerdict } from './worktree-integrity-verdict.js';
import type { WorktreeStatusSnapshot } from './worktree-status-snapshot.js';

/**
 * Stages tracked dirty files and size-bounded untracked files into a temporary git index to produce `treeSha`.
 *
 * Spills untracked (`?`) files exceeding `maxUntrackedBytes` into `<gitdir>/harness-ckpt-blobs/` via CoW/value copy.
 *
 * @param {GitWorktreeHandle}      handle            - Active worktree handle.
 * @param {WorktreeStatusSnapshot} snapshot          - Porcelain v2 status snapshot of the worktree.
 * @param {number}                 maxUntrackedBytes - Byte threshold above which untracked files spill to `harness-ckpt-blobs/`.
 *
 * @returns {Promise<StagedCheckpointTreeResult>} Synthesized tree SHA and spilled blob map.
 */
export async function stageCheckpointTreeAndOversizedBlobs(
  handle: GitWorktreeHandle,
  snapshot: WorktreeStatusSnapshot,
  maxUntrackedBytes: number,
): Promise<StagedCheckpointTreeResult> {
  const headSha = (await runGitCommand({ cwd: handle.worktreePath, args: ['rev-parse', 'HEAD'] })).stdout.trim();
  const tmpIndex = path.join(handle.gitDirPath, `harness-ckpt-idx.${process.pid}.${randomUUID()}`);
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  const oversized: Record<string, OversizedUntrackedBlobRecord> = {};
  try {
    await runGitCommand({ cwd: handle.worktreePath, args: ['read-tree', headSha], env: { GIT_INDEX_FILE: tmpIndex } });
    for (const [relPath, digest] of Object.entries(snapshot.statusMap)) {
      if (digest === 'DELETED') {
        toRemove.push(relPath);
        continue;
      }
      const absPath = path.join(handle.worktreePath, relPath);
      const stat = await lstat(absPath);
      if (snapshot.untrackedPaths.has(relPath) && stat.isFile() && stat.size > maxUntrackedBytes) {
        const blobKey = `${stat.size}_${Math.trunc(stat.mtimeMs)}_${digest.replace(':', '_')}`;
        await copyFileCowOrValue(absPath, path.join(handle.gitDirPath, 'harness-ckpt-blobs', blobKey), stat.mode);
        oversized[relPath] = Object.freeze({ blobKey, mode: stat.mode, size: stat.size });
      } else {
        toAdd.push(relPath);
      }
    }
    if (toRemove.length > 0) await runGitCommand({ cwd: handle.worktreePath, args: ['update-index', '--force-remove', '-z', '--stdin'], env: { GIT_INDEX_FILE: tmpIndex }, stdin: `${toRemove.join('\0')}\0` });
    if (toAdd.length > 0) await runGitCommand({ cwd: handle.worktreePath, args: ['update-index', '--add', '-z', '--stdin'], env: { GIT_INDEX_FILE: tmpIndex }, stdin: `${toAdd.join('\0')}\0` });
    const treeOutput = await runGitCommand({ cwd: handle.worktreePath, args: ['write-tree'], env: { GIT_INDEX_FILE: tmpIndex } });
    return Object.freeze<StagedCheckpointTreeResult>({ headSha, treeSha: treeOutput.stdout.trim(), oversizedUntrackedBlobs: Object.freeze(oversized) });
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

/**
 * Compares two `Readonly<Record<string, string>>` maps for exact key and value equality.
 *
 * @param {Readonly<Record<string, string>>} left  - First string map.
 * @param {Readonly<Record<string, string>>} right - Second string map.
 *
 * @returns {boolean} `true` when both maps contain the exact same keys and values.
 */
function isStringRecordEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/**
 * Compares two `HarnessMetaRecord` instances for structural equality without `JSON.stringify` key-order sensitivity.
 *
 * @param {HarnessMetaRecord} left  - Current metadata record read from disk.
 * @param {HarnessMetaRecord} right - Baseline metadata record stored in the checkpoint.
 *
 * @returns {boolean} `true` when both metadata records are structurally identical.
 */
function isHarnessMetaEqual(
  left: HarnessMetaRecord,
  right: HarnessMetaRecord,
): boolean {
  if (
    left.baseRef !== right.baseRef ||
    left.baseBranch !== right.baseBranch ||
    left.branchName !== right.branchName ||
    left.pendingParentHeadSha !== right.pendingParentHeadSha
  ) {
    return false;
  }
  if (!isStringRecordEqual(left.unresolvedConflictPaths, right.unresolvedConflictPaths)) {
    return false;
  }
  if ((left.inFlightMerge === undefined) !== (right.inFlightMerge === undefined)) {
    return false;
  }
  if (left.inFlightMerge !== undefined && right.inFlightMerge !== undefined) {
    if (
      left.inFlightMerge.targetHeadSha !== right.inFlightMerge.targetHeadSha ||
      left.inFlightMerge.mergedTreeSha !== right.inFlightMerge.mergedTreeSha ||
      left.inFlightMerge.priorTreeSha !== right.inFlightMerge.priorTreeSha ||
      !isStringRecordEqual(
        left.inFlightMerge.unresolvedConflictPaths,
        right.inFlightMerge.unresolvedConflictPaths,
      )
    ) {
      return false;
    }
  }
  if ((left.inFlightCommitAndPush === undefined) !== (right.inFlightCommitAndPush === undefined)) {
    return false;
  }
  if (left.inFlightCommitAndPush !== undefined && right.inFlightCommitAndPush !== undefined) {
    return (
      left.inFlightCommitAndPush.preStepHeadSha === right.inFlightCommitAndPush.preStepHeadSha &&
      left.inFlightCommitAndPush.preStepBaseRef === right.inFlightCommitAndPush.preStepBaseRef &&
      left.inFlightCommitAndPush.targetBranch === right.inFlightCommitAndPush.targetBranch
    );
  }
  return true;
}

/**
 * Verifies worktree-local `.git` metadata (`HEAD`, `indexTreeSha`, `info/exclude`, `harness-meta.json`) and `node_modules` integrity.
 *
 * Returns `{ intact: false, reason }` if any worktree-local metadata or `node_modules` tree was mutated by a subprocess.
 *
 * @param {GitWorktreeHandle}    handle         - Active worktree handle.
 * @param {GitCheckpointPayload} fromCheckpoint - Parsed baseline checkpoint payload.
 *
 * @returns {Promise<WorktreeIntegrityVerdict>} Integrity verification result.
 */
export async function verifyWorktreeLocalGitIntegrity(
  handle: GitWorktreeHandle,
  fromCheckpoint: GitCheckpointPayload,
): Promise<WorktreeIntegrityVerdict> {
  try {
    const headRaw = await readFile(path.join(handle.gitDirPath, 'HEAD'), 'utf8');
    if (headRaw !== fromCheckpoint.headRawContent) return { intact: false, reason: '<gitdir>/HEAD raw content was modified' };
    const headOutput = await runGitCommand({ cwd: handle.worktreePath, args: ['rev-parse', 'HEAD'], allowNonZeroExit: true });
    if (headOutput.exitCode !== 0 || headOutput.stdout.trim() !== fromCheckpoint.headSha) return { intact: false, reason: 'HEAD commit SHA was mutated' };
    const idxTreeOutput = await runGitCommand({ cwd: handle.worktreePath, args: ['write-tree'], allowNonZeroExit: true });
    if (idxTreeOutput.exitCode !== 0 || idxTreeOutput.stdout.trim() !== fromCheckpoint.indexTreeSha) return { intact: false, reason: '<gitdir>/index was mutated' };
    const infoExclude = await readFile(path.join(handle.gitDirPath, 'info', 'exclude'), 'utf8').catch(() => null);
    if (infoExclude !== fromCheckpoint.infoExcludeContent) return { intact: false, reason: '<gitdir>/info/exclude was mutated' };
    const meta = await readHarnessMeta(handle.gitDirPath);
    if (!isHarnessMetaEqual(meta, fromCheckpoint.meta)) return { intact: false, reason: '<gitdir>/harness-meta.json was mutated' };
    const nmDigest = await computeNodeModulesDigest(handle.worktreePath);
    if (nmDigest !== fromCheckpoint.nodeModulesDigest) return { intact: false, reason: 'node_modules tree was mutated' };
    return { intact: true };
  } catch (err) {
    return { intact: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Lists all repository-relative file paths recorded inside a Git tree object (`git ls-tree -r --name-only -z`).
 *
 * Returns a `ReadonlySet<string>` for $O(1)$ membership queries during checkpoint restoration and merge materialization.
 *
 * @param {string} worktreePath - Worktree directory path.
 * @param {string} treeOrCommit - Git tree or commit SHA to list.
 *
 * @returns {Promise<ReadonlySet<string>>} Set of repository-relative file paths in `treeOrCommit`.
 */
export async function listTreePaths(
  worktreePath: string,
  treeOrCommit: string,
): Promise<ReadonlySet<string>> {
  const lsTreeOutput = await runGitCommand({
    cwd: worktreePath,
    args: ['ls-tree', '-r', '--name-only', '-z', treeOrCommit],
  });
  const paths = new Set<string>();
  for (const entry of lsTreeOutput.stdout.split('\0')) {
    if (entry.length > 0) paths.add(entry);
  }
  return paths;
}

/**
 * Computes the sorted symmetric difference of paths whose `${mode}:${sha256}` status changed between two status maps.
 *
 * Includes paths added, deleted, modified, or reverted back to clean `HEAD` between `beforeMap` and `afterMap`.
 *
 * @param {Readonly<Record<string, string>>} beforeMap - Baseline status map from `fromCheckpoint`.
 * @param {Readonly<Record<string, string>>} afterMap  - Current worktree status map.
 *
 * @returns {readonly string[]} Lexicographically sorted list of changed repository-relative paths.
 */
export function computeSymmetricStatusDiff(
  beforeMap: Readonly<Record<string, string>>,
  afterMap: Readonly<Record<string, string>>,
): readonly string[] {
  const changed = new Set<string>();
  for (const [relPath, digest] of Object.entries(beforeMap)) {
    if (afterMap[relPath] !== digest) changed.add(relPath);
  }
  for (const [relPath, digest] of Object.entries(afterMap)) {
    if (beforeMap[relPath] !== digest) changed.add(relPath);
  }
  const sorted = [...changed];
  sorted.sort();
  return Object.freeze(sorted);
}
