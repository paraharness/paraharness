import type {
  GitCommitAndPushNode,
  GitWorktreeHandle,
  StepExecutionContext,
} from '@harness-dsl/core';
import { flushParentWorkingTreeCleanChanges } from './conflict-pruning-and-parent-flush.js';
import {
  readHarnessMeta,
  runGitCommand,
  writeHarnessMeta,
} from './git-cli-runner.js';
import { evaluateWorktreeCheck } from './merge-train-bisector.js';
import { resolveEffectiveBaseBranch } from './resolve-effective-base-branch.js';

/**
 * Executes the atomic squash, rebase, verify, and `--force-with-lease` push sequence for `git.commitAndPush`.
 *
 * Persists `inFlightCommitAndPush` before mutating `HEAD` and rolls back to `preStepHeadSha` on any failure.
 *
 * @param {GitCommitAndPushNode<unknown>}           node        - Commit-and-push step AST node.
 * @param {unknown}                                 parsedInput - Validated step input payload.
 * @param {StepExecutionContext<GitWorktreeHandle>} ctx         - Active step execution context.
 *
 * @returns {Promise<void>} Resolves once the squashed branch is pushed and `rootHandle` lineage is updated.
 */
export async function runSquashRebaseAndPush(
  node: GitCommitAndPushNode<unknown>,
  parsedInput: unknown,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<void> {
  const rootHandle = ctx.scopeHandle;
  const cwd = rootHandle.worktreePath;
  const scopeNode = ctx.scopeNode?.type === 'git:cow-worktree' ? ctx.scopeNode : undefined;
  const env: Record<string, string | undefined> = {};
  if (node.env !== undefined) {
    for (const [k, v] of Object.entries(node.env)) env[k] = ctx.resolveEnv(v);
  }
  await flushParentWorkingTreeCleanChanges(rootHandle, scopeNode?.checkpointPolicy?.excludeGlobs);
  const preStepHeadSha = (await runGitCommand({ cwd, args: ['rev-parse', 'HEAD'], env })).stdout.trim();
  let meta = await readHarnessMeta(rootHandle.gitDirPath);
  const preStepBaseRef = meta.baseRef;
  const targetBranch = node.branch(parsedInput);
  const commitMessage = node.message(parsedInput);
  meta = { ...meta, inFlightCommitAndPush: { preStepHeadSha, preStepBaseRef, targetBranch } };
  await writeHarnessMeta(rootHandle.gitDirPath, meta);
  try {
    await runGitCommand({ cwd, args: ['fetch', 'origin'], env, allowNonZeroExit: true });
    const resolvedBaseBranch = await resolveEffectiveBaseBranch(cwd, meta.baseBranch || rootHandle.baseBranch || 'main', preStepBaseRef);
    const treeSha = (await runGitCommand({ cwd, args: ['rev-parse', `${preStepHeadSha}^{tree}`], env })).stdout.trim();
    const squashedSha = (await runGitCommand({
      cwd,
      args: ['commit-tree', treeSha, '-p', preStepBaseRef, '-m', commitMessage],
      env,
    })).stdout.trim();
    await runGitCommand({ cwd, args: ['reset', '--hard', squashedSha], env });
    const remoteRefCheck = await runGitCommand({
      cwd,
      args: ['rev-parse', '--verify', `refs/remotes/origin/${resolvedBaseBranch}`],
      env,
      allowNonZeroExit: true,
    });
    const upstreamRef = remoteRefCheck.exitCode === 0 ? `refs/remotes/origin/${resolvedBaseBranch}` : resolvedBaseBranch;
    const upstreamSha = (await runGitCommand({ cwd, args: ['rev-parse', upstreamRef], env })).stdout.trim();
    await runGitCommand({ cwd, args: ['rebase', '--onto', upstreamSha, preStepBaseRef, 'HEAD'], env });
    const verifyCheck = scopeNode?.reconcileStrategy?.verifyWith;
    if (verifyCheck !== undefined) {
      const checkRes = await evaluateWorktreeCheck(verifyCheck, ctx);
      if (!checkRes.ok) {
        throw new Error(`Reconcile verification check '${verifyCheck.id}' failed: ${checkRes.deficits.join('; ')}`);
      }
    }
    await runGitCommand({ cwd, args: ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${targetBranch}`], env });
    const pushedCommitSha = (await runGitCommand({ cwd, args: ['rev-parse', 'HEAD'], env })).stdout.trim();
    meta = { ...meta, baseRef: upstreamSha, baseBranch: resolvedBaseBranch, branchName: targetBranch, inFlightCommitAndPush: undefined };
    await writeHarnessMeta(rootHandle.gitDirPath, meta);
    Object.assign(rootHandle, { baseRef: upstreamSha, baseBranch: resolvedBaseBranch, branchName: targetBranch, headRef: pushedCommitSha });
  } catch (err) {
    await runGitCommand({ cwd, args: ['rebase', '--abort'], env, allowNonZeroExit: true });
    await runGitCommand({ cwd, args: ['reset', '--hard', preStepHeadSha], env });
    meta = { ...meta, baseRef: preStepBaseRef, inFlightCommitAndPush: undefined };
    await writeHarnessMeta(rootHandle.gitDirPath, meta);
    Object.assign(rootHandle, { baseRef: preStepBaseRef, headRef: preStepHeadSha });
    throw err;
  }
}
