import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { GitCowWorktreeNode, GitWorktreeHandle } from '@metaharness/core';
import type { HarnessMetaRecord } from '../../schemas/git-receipts.schema.js';
import {
  cloneNodeModulesTree,
  hydrateWorktreeDependencies,
} from './cow-worktree-hydrator.js';
import { gitCheckpointRestore } from './git-checkpoint-restore.js';
import {
  readHarnessMeta,
  runGitCommand,
  withHostWorktreeLock,
  writeHarnessMeta,
} from './git-cli-runner.js';
import { gitWorktreeMaterializeMerge } from './git-worktree-materialize-merge.js';

/**
 * Parameters for reattaching or recreating a child fork worktree during crash recovery.
 */
export interface ReattachChildWorktreeParams {
  /** Worktree scope AST node configuration. */
  readonly node: GitCowWorktreeNode;
  /** Reattached parent worktree handle. */
  readonly parent: GitWorktreeHandle;
  /** Unique child fork or branch identifier. */
  readonly forkId: string;
  /** Optional serialized checkpoint fallback when the directory is missing. */
  readonly checkpoint?: string;
}

/**
 * Parameters for recreating a missing Task Root Worktree from pinned refs or `checkpoint`.
 */
interface RecreateMissingRootWorktreeParams {
  /** Worktree scope AST node configuration. */
  readonly node: GitCowWorktreeNode;
  /** Host repository root path. */
  readonly repoPath: string;
  /** Sanitized flow run identifier. */
  readonly safeRunId: string;
  /** Target root worktree path on disk. */
  readonly worktreePath: string;
  /** Optional serialized checkpoint fallback. */
  readonly checkpoint?: string;
}

/**
 * Parameters for recreating a missing child fork worktree from pinned refs or `checkpoint`.
 */
interface RecreateMissingChildWorktreeParams {
  /** Reattachment parameters supplied by the scope driver. */
  readonly params: ReattachChildWorktreeParams;
  /** Flow run identifier owning the fork. */
  readonly runId: string;
  /** Sanitized fork identifier. */
  readonly safeForkId: string;
  /** Target child worktree path on disk. */
  readonly worktreePath: string;
}

/**
 * Merges `node.excludeFromCloneGlobs` and `node.checkpointPolicy?.excludeGlobs` into an effective checkpoint policy.
 *
 * Precomputes the combined exclusion globs so checkpoint serialization, diffing, and restoration share one policy.
 *
 * @param {Pick<GitCowWorktreeNode, 'excludeFromCloneGlobs' | 'checkpointPolicy'>} node - Passive worktree scope AST configuration node.
 *
 * @returns {GitCowWorktreeNode['checkpointPolicy']} Effective checkpoint policy with merged `excludeGlobs`.
 */
export function resolveEffectiveCheckpointPolicy(
  node: Pick<GitCowWorktreeNode, 'excludeFromCloneGlobs' | 'checkpointPolicy'>,
): GitCowWorktreeNode['checkpointPolicy'] {
  const cloneGlobs = node.excludeFromCloneGlobs ?? [];
  const policyGlobs = node.checkpointPolicy?.excludeGlobs ?? [];
  if (cloneGlobs.length === 0 && node.checkpointPolicy === undefined) {
    return undefined;
  }
  const mergedGlobs = Object.freeze([
    ...new Set([...cloneGlobs, ...policyGlobs]),
  ]);
  return Object.freeze({
    partitionMap: node.checkpointPolicy?.partitionMap,
    excludeGlobs: mergedGlobs,
    maxUntrackedFileSizeBytes:
      node.checkpointPolicy?.maxUntrackedFileSizeBytes,
  });
}

/**
 * Rolls back an interrupted `inFlightCommitAndPush` transition on `worktreePath` to `preStepHeadSha` and `preStepBaseRef`.
 *
 * Aborts any in-progress rebase, resets `HEAD` to `preStepHeadSha`, and clears `inFlightCommitAndPush` in `harness-meta.json`.
 *
 * @param {string}            worktreePath - Absolute path to the worktree directory.
 * @param {string}            gitDirPath   - Absolute path to the worktree's `<gitdir>`.
 * @param {HarnessMetaRecord} meta         - Current metadata record containing `inFlightCommitAndPush`.
 *
 * @returns {Promise<HarnessMetaRecord>} Updated `HarnessMetaRecord` with `inFlightCommitAndPush` cleared.
 */
async function rollbackInFlightCommitAndPush(
  worktreePath: string,
  gitDirPath: string,
  meta: HarnessMetaRecord,
): Promise<HarnessMetaRecord> {
  const commitState = meta.inFlightCommitAndPush;
  if (commitState === undefined) return meta;
  await runGitCommand({
    cwd: worktreePath,
    args: ['rebase', '--abort'],
    allowNonZeroExit: true,
  });
  await runGitCommand({
    cwd: worktreePath,
    args: ['reset', '--hard', commitState.preStepHeadSha],
  });
  const updatedMeta: HarnessMetaRecord = {
    ...meta,
    baseRef: commitState.preStepBaseRef,
    inFlightCommitAndPush: undefined,
  };
  await writeHarnessMeta(gitDirPath, updatedMeta);
  return updatedMeta;
}

/**
 * Completes or rolls back any interrupted atomic metadata state (`pendingParentHeadSha`, `inFlightMerge`, `inFlightCommitAndPush`).
 *
 * Preserves intact working-tree edits across process reboots when no in-flight atomic transition was interrupted.
 *
 * @param {string} worktreePath - Absolute path to the existing worktree directory on disk.
 *
 * @returns {Promise<GitWorktreeHandle>} Rebound and recovered `GitWorktreeHandle`.
 */
export async function recoverInFlightWorktreeState(
  worktreePath: string,
): Promise<GitWorktreeHandle> {
  const gitDirResult = await runGitCommand({
    cwd: worktreePath,
    args: ['rev-parse', '--git-dir'],
  });
  const gitDirPath = path.resolve(worktreePath, gitDirResult.stdout.trim());
  let meta = await readHarnessMeta(gitDirPath);
  if (meta.pendingParentHeadSha !== undefined) {
    await runGitCommand({
      cwd: worktreePath,
      args: ['update-ref', 'HEAD', meta.pendingParentHeadSha],
    });
    meta = { ...meta, pendingParentHeadSha: undefined };
    await writeHarnessMeta(gitDirPath, meta);
  }
  if (meta.inFlightMerge !== undefined) {
    const mergeState = meta.inFlightMerge;
    const tempHandle: GitWorktreeHandle = {
      worktreePath,
      gitDirPath,
      baseRef: meta.baseRef,
      baseBranch: meta.baseBranch,
      branchName: meta.branchName,
      headRef: meta.baseRef,
      unresolvedConflictPaths: meta.unresolvedConflictPaths,
    };
    await gitWorktreeMaterializeMerge(tempHandle, {
      targetHeadSha: mergeState.targetHeadSha,
      mergedTreeSha: mergeState.mergedTreeSha,
      priorTreeSha: mergeState.priorTreeSha,
      conflictedPaths: Object.keys(mergeState.unresolvedConflictPaths),
    });
    meta = await readHarnessMeta(gitDirPath);
  }
  if (meta.inFlightCommitAndPush !== undefined) {
    meta = await rollbackInFlightCommitAndPush(worktreePath, gitDirPath, meta);
  }
  const headResult = await runGitCommand({
    cwd: worktreePath,
    args: ['rev-parse', 'HEAD'],
  });
  return {
    worktreePath,
    gitDirPath,
    baseRef: meta.baseRef,
    baseBranch: meta.baseBranch,
    branchName: meta.branchName,
    headRef: headResult.stdout.trim(),
    unresolvedConflictPaths: meta.unresolvedConflictPaths,
  };
}

/**
 * Recreates a missing Task Root Worktree at `params.worktreePath` from a pinned completed ref or host `HEAD`,
 * hydrates `node_modules`, and restores `params.checkpoint` when provided.
 *
 * @param {RecreateMissingRootWorktreeParams} params - Root worktree recreation parameters.
 *
 * @returns {Promise<GitWorktreeHandle>} Newly recreated root `GitWorktreeHandle`.
 */
async function recreateMissingRootWorktree(
  params: RecreateMissingRootWorktreeParams,
): Promise<GitWorktreeHandle> {
  const { node, repoPath, safeRunId, worktreePath, checkpoint } = params;
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const baseRef = await withHostWorktreeLock(
    repoPath,
    async (): Promise<string> => {
      await runGitCommand({
        cwd: repoPath,
        args: ['worktree', 'prune'],
        allowNonZeroExit: true,
      });
      const pinnedResult = await runGitCommand({
        cwd: repoPath,
        args: [
          'rev-parse',
          '--verify',
          `refs/harness/completed/roots/${safeRunId}`,
        ],
        allowNonZeroExit: true,
      });
      const fallbackHeadResult = await runGitCommand({
        cwd: repoPath,
        args: ['rev-parse', 'HEAD'],
      });
      const resolvedBaseRef =
        pinnedResult.exitCode === 0 && pinnedResult.stdout.trim().length > 0
          ? pinnedResult.stdout.trim()
          : fallbackHeadResult.stdout.trim();
      await runGitCommand({
        cwd: repoPath,
        args: [
          'worktree',
          'add',
          '--detach',
          '--force',
          worktreePath,
          resolvedBaseRef,
        ],
      });
      return resolvedBaseRef;
    },
  );
  const gitDirResult = await runGitCommand({
    cwd: worktreePath,
    args: ['rev-parse', '--git-dir'],
  });
  const gitDirPath = path.resolve(worktreePath, gitDirResult.stdout.trim());
  await hydrateWorktreeDependencies(node, repoPath, worktreePath);
  const emptyConflicts: Readonly<Record<string, string>> = Object.freeze({});
  await writeHarnessMeta(gitDirPath, {
    baseRef,
    baseBranch: 'main',
    unresolvedConflictPaths: emptyConflicts,
  });
  const handle: GitWorktreeHandle = {
    worktreePath,
    gitDirPath,
    baseRef,
    baseBranch: 'main',
    headRef: baseRef,
    unresolvedConflictPaths: emptyConflicts,
  };
  if (checkpoint !== undefined) {
    await gitCheckpointRestore(
      handle,
      checkpoint,
      resolveEffectiveCheckpointPolicy(node),
    );
  }
  return handle;
}

/**
 * Rebinds an existing Task Root Worktree at `<dir>/roots/<runId>` or recreates it from `checkpoint` if missing.
 *
 * Completes interrupted `pendingParentHeadSha` or `inFlightMerge` transitions and rolls back `inFlightCommitAndPush`.
 *
 * @param {GitCowWorktreeNode} node         - Worktree scope AST node configuration.
 * @param {string}             runId        - Unique flow run identifier.
 * @param {string}             [checkpoint] - Optional serialized checkpoint fallback when the directory is missing.
 *
 * @returns {Promise<GitWorktreeHandle>} Reattached root `GitWorktreeHandle`.
 */
export async function gitWorktreeReattachRoot(
  node: GitCowWorktreeNode,
  runId: string,
  checkpoint?: string,
): Promise<GitWorktreeHandle> {
  const repoPath = path.resolve(node.repo);
  const baseDir = path.isAbsolute(node.dir)
    ? node.dir
    : path.resolve(repoPath, node.dir);
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const worktreePath = path.join(baseDir, 'roots', safeRunId);
  const exists = await lstat(worktreePath).then(
    () => true,
    () => false,
  );
  if (exists) return recoverInFlightWorktreeState(worktreePath);
  return recreateMissingRootWorktree({
    node,
    repoPath,
    safeRunId,
    worktreePath,
    checkpoint,
  });
}

/**
 * Recreates a missing child fork worktree at `recreateParams.worktreePath` from a pinned completed ref or `parent`,
 * clones `node_modules`, and restores `recreateParams.params.checkpoint` when provided.
 *
 * @param {RecreateMissingChildWorktreeParams} recreateParams - Child worktree recreation parameters.
 *
 * @returns {Promise<GitWorktreeHandle>} Newly recreated child `GitWorktreeHandle`.
 */
async function recreateMissingChildWorktree(
  recreateParams: RecreateMissingChildWorktreeParams,
): Promise<GitWorktreeHandle> {
  const { params, runId, safeForkId, worktreePath } = recreateParams;
  const { node, parent, checkpoint } = params;
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const baseRef = await withHostWorktreeLock(
    parent.worktreePath,
    async (): Promise<string> => {
      await runGitCommand({
        cwd: parent.worktreePath,
        args: ['worktree', 'prune'],
        allowNonZeroExit: true,
      });
      const pinnedResult = await runGitCommand({
        cwd: parent.worktreePath,
        args: [
          'rev-parse',
          '--verify',
          `refs/harness/completed/forks/${runId}/${safeForkId}`,
        ],
        allowNonZeroExit: true,
      });
      const resolvedBaseRef =
        pinnedResult.exitCode === 0 && pinnedResult.stdout.trim().length > 0
          ? pinnedResult.stdout.trim()
          : (parent.headRef ?? parent.baseRef);
      await runGitCommand({
        cwd: parent.worktreePath,
        args: [
          'worktree',
          'add',
          '--detach',
          '--force',
          worktreePath,
          resolvedBaseRef,
        ],
      });
      return resolvedBaseRef;
    },
  );
  const gitDirResult = await runGitCommand({
    cwd: worktreePath,
    args: ['rev-parse', '--git-dir'],
  });
  const gitDirPath = path.resolve(worktreePath, gitDirResult.stdout.trim());
  await cloneNodeModulesTree(
    parent.worktreePath,
    worktreePath,
    node.excludeFromCloneGlobs,
  );
  const emptyConflicts: Readonly<Record<string, string>> = Object.freeze({});
  await writeHarnessMeta(gitDirPath, {
    baseRef,
    baseBranch: parent.baseBranch,
    branchName: parent.branchName,
    unresolvedConflictPaths: emptyConflicts,
  });
  const handle: GitWorktreeHandle = {
    worktreePath,
    gitDirPath,
    baseRef,
    baseBranch: parent.baseBranch,
    branchName: parent.branchName,
    headRef: baseRef,
    unresolvedConflictPaths: emptyConflicts,
  };
  if (checkpoint !== undefined) {
    await gitCheckpointRestore(
      handle,
      checkpoint,
      resolveEffectiveCheckpointPolicy(node),
    );
  }
  return handle;
}

/**
 * Rebinds an existing child fork worktree at `<dir>/forks/<runId>/<forkId>` or recreates it from `checkpoint` if missing.
 *
 * Completes any interrupted `inFlightMerge` materialization and preserves uncommitted child edits across reboots.
 *
 * @param {ReattachChildWorktreeParams} params - Child worktree reattachment parameters.
 *
 * @returns {Promise<GitWorktreeHandle>} Reattached child `GitWorktreeHandle`.
 */
export async function gitWorktreeReattachChild(
  params: ReattachChildWorktreeParams,
): Promise<GitWorktreeHandle> {
  const { parent, forkId } = params;
  const parentDir = path.dirname(parent.worktreePath);
  const isParentRoot = path.basename(parentDir) === 'roots';
  const runId = isParentRoot
    ? path.basename(parent.worktreePath)
    : path.basename(parentDir);
  const baseDir = isParentRoot
    ? path.dirname(parentDir)
    : path.dirname(path.dirname(parentDir));
  const safeForkId = forkId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const worktreePath = path.join(baseDir, 'forks', runId, safeForkId);
  const exists = await lstat(worktreePath).then(
    () => true,
    () => false,
  );
  if (exists) return recoverInFlightWorktreeState(worktreePath);
  return recreateMissingChildWorktree({
    params,
    runId,
    safeForkId,
    worktreePath,
  });
}
