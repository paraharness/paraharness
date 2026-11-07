import type {
  AbortHookExecutionInput,
  CheckEvaluationResult,
  GitAbortMeta,
  GitCleanWorkingTreeNode,
  GitDiscardBranchNode,
  GitKeepWorktreeNode,
  GitSnapshotAndResetNode,
  GitWorktreeHandle,
  RewindHookExecutionInput,
  StepExecutionContext,
} from '@harness-dsl/core';
import { pruneResolvedConflictPaths } from './internal/conflict-pruning-and-parent-flush.js';
import {
  readHarnessMeta,
  runGitCommand,
  writeHarnessMeta,
} from './internal/git-cli-runner.js';
import { synthesizeWorkingTreeCommitOverBase } from './internal/merge-tree-materializer.js';
import { findWorktreeConflictMarkerPaths } from './internal/parent-fast-forward.js';
import { restoreGitWorktreeCheckpoint } from './internal/porcelain-v2-and-checkpoints.js';

/**
 * Evaluates a `GitCleanWorkingTreeNode` (`git:clean-working-tree`) conflict-clean check on `ctx.scopeHandle`.
 *
 * Prunes resolved entries in `unresolvedConflictPaths` and rejects if any unresolved paths or paired conflict markers remain.
 *
 * @param {GitCleanWorkingTreeNode}                 _node  - Passive clean-working-tree check AST node.
 * @param {void}                                    _input - Unused check input.
 * @param {StepExecutionContext<GitWorktreeHandle>} ctx    - Active step execution context.
 *
 * @returns {Promise<CheckEvaluationResult>} Check evaluation result listing any remaining conflicted paths.
 */
export async function executeGitCleanWorkingTreeCheck(
  _node: GitCleanWorkingTreeNode,
  _input: void,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<CheckEvaluationResult> {
  const handle = ctx.scopeHandle;
  const scopeNode = ctx.scopeNode?.type === 'git:cow-worktree' ? ctx.scopeNode : undefined;
  const remaining = await pruneResolvedConflictPaths(handle);
  const markerPaths = await findWorktreeConflictMarkerPaths(handle, scopeNode?.checkpointPolicy?.excludeGlobs);
  const unresolvedSet = new Set<string>([...Object.keys(remaining), ...markerPaths]);
  if (unresolvedSet.size === 0) {
    return { ok: true, deficits: [] };
  }
  const sorted = [...unresolvedSet].sort();
  return {
    ok: false,
    deficits: sorted.map((relPath) => `Unresolved git merge conflict in '${relPath}'.`),
  };
}

/**
 * Executes a `GitSnapshotAndResetNode` (`git.snapshotAndReset()`) abort hook on `input.handle`.
 *
 * Idempotently snapshots dirty state over `baseRef` to `refs/harness/aborted/<runId>/<stepExecId>`,
 * resets the worktree to `baseRef`, and clears `unresolvedConflictPaths`.
 *
 * @param {GitSnapshotAndResetNode}                    _node - Passive snapshot-and-reset abort hook AST node.
 * @param {AbortHookExecutionInput<GitWorktreeHandle>} input - Abort hook execution input with handle and run/step IDs.
 * @param {StepExecutionContext<GitWorktreeHandle>}    ctx   - Active step execution context.
 *
 * @returns {Promise<GitAbortMeta>} Validated `{ abortedSnapshotRef, resetToRef }` abort metadata receipt.
 */
export async function executeGitSnapshotAndResetHook(
  _node: GitSnapshotAndResetNode,
  input: AbortHookExecutionInput<GitWorktreeHandle>,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<GitAbortMeta> {
  const handle = input.handle;
  const cwd = handle.worktreePath;
  const scopeNode = ctx.scopeNode?.type === 'git:cow-worktree' ? ctx.scopeNode : undefined;
  const abortedSnapshotRef = `refs/harness/aborted/${input.runId}/${input.stepExecId}`;
  const synth = await synthesizeWorkingTreeCommitOverBase(handle, handle.baseRef, scopeNode?.checkpointPolicy?.excludeGlobs);
  const baseTreeSha = (await runGitCommand({ cwd, args: ['rev-parse', `${handle.baseRef}^{tree}`] })).stdout.trim();
  const existingRef = await runGitCommand({ cwd, args: ['rev-parse', '--verify', abortedSnapshotRef], allowNonZeroExit: true });
  if (synth.treeSha !== baseTreeSha || existingRef.exitCode !== 0) {
    await runGitCommand({ cwd, args: ['update-ref', abortedSnapshotRef, synth.commitSha] });
  }
  await runGitCommand({ cwd, args: ['reset', '--hard', handle.baseRef] });
  await runGitCommand({ cwd, args: ['clean', '-fd', '-e', 'node_modules', '-e', '**/node_modules'] });
  const meta = await readHarnessMeta(handle.gitDirPath);
  const emptyConflicts: Readonly<Record<string, string>> = Object.freeze({});
  await writeHarnessMeta(handle.gitDirPath, { ...meta, unresolvedConflictPaths: emptyConflicts });
  Object.assign(handle, { headRef: handle.baseRef, unresolvedConflictPaths: emptyConflicts });
  return { abortedSnapshotRef, resetToRef: handle.baseRef };
}

/**
 * Executes a `GitKeepWorktreeNode` (`git.keepWorktree()`) rewind hook on `input.handle`.
 *
 * Preserves the current working tree, `HEAD`, and `baseRef` in-place across `.rewindTo()` transitions.
 *
 * @param {GitKeepWorktreeNode}                         _node  - Passive keep-worktree rewind hook AST node.
 * @param {RewindHookExecutionInput<GitWorktreeHandle>} _input - Rewind hook execution input.
 * @param {StepExecutionContext<GitWorktreeHandle>}     _ctx   - Active step execution context.
 *
 * @returns {Promise<void>} Resolves immediately without mutating the worktree.
 */
export function executeGitKeepWorktreeHook(
  _node: GitKeepWorktreeNode,
  _input: RewindHookExecutionInput<GitWorktreeHandle>,
  _ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<void> {
  return Promise.resolve();
}

/**
 * Executes a `GitDiscardBranchNode` (`git.resetWorktree()` / `git.discardBranch()`) rewind hook on `input.handle`.
 *
 * Restores `input.handle` to `input.targetStepBaseScopeCheckpoint` (or resets to `handle.baseRef` if absent).
 *
 * @param {GitDiscardBranchNode}                        _node - Passive discard-branch rewind hook AST node.
 * @param {RewindHookExecutionInput<GitWorktreeHandle>} input - Rewind hook execution input.
 * @param {StepExecutionContext<GitWorktreeHandle>}     ctx   - Active step execution context.
 *
 * @returns {Promise<void>} Resolves once the worktree is restored to the target step's base checkpoint.
 */
export async function executeGitDiscardBranchHook(
  _node: GitDiscardBranchNode,
  input: RewindHookExecutionInput<GitWorktreeHandle>,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<void> {
  const handle = input.handle;
  const scopeNode = ctx.scopeNode?.type === 'git:cow-worktree' ? ctx.scopeNode : undefined;
  if (input.targetStepBaseScopeCheckpoint !== undefined) {
    await restoreGitWorktreeCheckpoint(handle, input.targetStepBaseScopeCheckpoint, scopeNode?.checkpointPolicy);
    return;
  }
  await runGitCommand({ cwd: handle.worktreePath, args: ['reset', '--hard', handle.baseRef] });
  await runGitCommand({ cwd: handle.worktreePath, args: ['clean', '-fd', '-e', 'node_modules', '-e', '**/node_modules'] });
  const meta = await readHarnessMeta(handle.gitDirPath);
  const emptyConflicts: Readonly<Record<string, string>> = Object.freeze({});
  await writeHarnessMeta(handle.gitDirPath, { ...meta, unresolvedConflictPaths: emptyConflicts });
  Object.assign(handle, { headRef: handle.baseRef, unresolvedConflictPaths: emptyConflicts });
}
