import type {
  GitCommitAndPushNode,
  GitWorktreeHandle,
  StepExecutionContext,
} from '@harness-dsl/core';
import type { HarnessMetaRecord } from '../../schemas/git-receipts.schema.js';
import {
  readHarnessMeta,
  runGitCommand,
  updateWorktreeHandleInPlace,
  writeHarnessMeta,
} from './git-cli-runner.js';
import { evaluateWorktreeCheck } from './git-merge-train-bisect.js';
import { gitWorktreeFlushCleanParentChanges } from './git-worktree-flush-and-prune.js';
import { resolveEffectiveCheckpointPolicy } from './git-worktree-reattach.js';
import { resolveEffectiveBaseBranch } from './resolve-effective-base-branch.js';

/**
 * Parameters for squashing, rebasing, pushing, and finalizing root worktree lineage in `git.commitAndPush`.
 */
interface SquashRebasePhaseParams {
  /** Active root worktree handle. */
  readonly rootHandle: GitWorktreeHandle;
  /** In-flight metadata record persisted prior to mutating `HEAD`. */
  readonly inFlightMeta: HarnessMetaRecord;
  /** Commit SHA of `HEAD` before squashing. */
  readonly preStepHeadSha: string;
  /** Base commit SHA recorded before squashing. */
  readonly preStepBaseRef: string;
  /** Target branch name to push to on `origin`. */
  readonly targetBranch: string;
  /** Commit message for the squashed commit. */
  readonly commitMessage: string;
  /** Resolved environment variables for git subprocesses. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolves symbolic `EnvRef` entries configured on `node.env` via `ctx.resolveEnv`.
 *
 * @param {GitCommitAndPushNode<unknown>}           node - Commit-and-push step AST node.
 * @param {StepExecutionContext<GitWorktreeHandle>} ctx  - Active step execution context.
 *
 * @returns {Readonly<Record<string, string | undefined>>} Resolved environment variable map.
 */
function resolveCommitAndPushEnv(
  node: GitCommitAndPushNode<unknown>,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Readonly<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = {};
  if (node.env !== undefined) {
    for (const [key, refOrValue] of Object.entries(node.env)) {
      env[key] = ctx.resolveEnv(refOrValue);
    }
  }
  return Object.freeze(env);
}

/**
 * Rolls back an interrupted or failed `git.commitAndPush` execution to `preStepHeadSha` and `preStepBaseRef`.
 *
 * @param {GitWorktreeHandle}                             rootHandle - Active root worktree handle.
 * @param {HarnessMetaRecord}                             meta       - Current `harness-meta.json` record containing `inFlightCommitAndPush`.
 * @param {Readonly<Record<string, string | undefined>>}  env        - Resolved environment variables.
 *
 * @returns {Promise<void>} Resolves once `HEAD`, `baseRef`, and `harness-meta.json` are restored.
 */
async function rollbackFailedCommitAndPush(
  rootHandle: GitWorktreeHandle,
  meta: HarnessMetaRecord,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const inFlight = meta.inFlightCommitAndPush;
  if (inFlight === undefined) return;
  const cwd = rootHandle.worktreePath;
  await runGitCommand({ cwd, args: ['rebase', '--abort'], env, allowNonZeroExit: true });
  await runGitCommand({ cwd, args: ['reset', '--hard', inFlight.preStepHeadSha], env });
  const restoredMeta: HarnessMetaRecord = {
    ...meta,
    baseRef: inFlight.preStepBaseRef,
    inFlightCommitAndPush: undefined,
  };
  await writeHarnessMeta(rootHandle.gitDirPath, restoredMeta);
  updateWorktreeHandleInPlace(rootHandle, {
    baseRef: inFlight.preStepBaseRef,
    headRef: inFlight.preStepHeadSha,
  });
}

/**
 * Fetches `origin`, resolves the effective stacked-PR base branch, synthesizes a single squashed commit over
 * `preStepBaseRef`, and rebases `HEAD` onto `origin/<resolvedBaseBranch>`.
 *
 * @param {SquashRebasePhaseParams} params - Squash and rebase phase parameters.
 *
 * @returns {Promise<readonly [string, string]>} Tuple of `[resolvedBaseBranch, upstreamSha]`.
 */
async function squashAndRebaseOntoUpstream(
  params: SquashRebasePhaseParams,
): Promise<readonly [string, string]> {
  const {
    rootHandle,
    inFlightMeta,
    preStepHeadSha,
    preStepBaseRef,
    commitMessage,
    env,
  } = params;
  const cwd = rootHandle.worktreePath;
  await runGitCommand({
    cwd,
    args: ['fetch', 'origin'],
    env,
    allowNonZeroExit: true,
  });
  const resolvedBaseBranch = await resolveEffectiveBaseBranch(
    cwd,
    inFlightMeta.baseBranch || rootHandle.baseBranch || 'main',
    preStepBaseRef,
  );
  const treeSha = (
    await runGitCommand({
      cwd,
      args: ['rev-parse', `${preStepHeadSha}^{tree}`],
      env,
    })
  ).stdout.trim();
  const squashedSha = (
    await runGitCommand({
      cwd,
      args: ['commit-tree', treeSha, '-p', preStepBaseRef, '-m', commitMessage],
      env,
    })
  ).stdout.trim();
  await runGitCommand({ cwd, args: ['reset', '--hard', squashedSha], env });
  const remoteRefCheck = await runGitCommand({
    cwd,
    args: [
      'rev-parse',
      '--verify',
      `refs/remotes/origin/${resolvedBaseBranch}`,
    ],
    env,
    allowNonZeroExit: true,
  });
  const upstreamRef =
    remoteRefCheck.exitCode === 0
      ? `refs/remotes/origin/${resolvedBaseBranch}`
      : resolvedBaseBranch;
  const upstreamSha = (
    await runGitCommand({ cwd, args: ['rev-parse', upstreamRef], env })
  ).stdout.trim();
  await runGitCommand({
    cwd,
    args: ['rebase', '--onto', upstreamSha, preStepBaseRef, 'HEAD'],
    env,
  });
  return [resolvedBaseBranch, upstreamSha] as const;
}

/**
 * Pushes the verified `HEAD` commit to `origin` with `--force-with-lease` and updates `harness-meta.json` and `rootHandle`.
 *
 * @param {SquashRebasePhaseParams} params             - Push and finalization parameters.
 * @param {string}                  resolvedBaseBranch - Resolved effective base branch name.
 * @param {string}                  upstreamSha        - Commit SHA of `origin/<resolvedBaseBranch>`.
 *
 * @returns {Promise<void>} Resolves once `origin` is updated and `rootHandle` lineage is finalized.
 */
async function pushAndFinalizeRootLineage(
  params: SquashRebasePhaseParams,
  resolvedBaseBranch: string,
  upstreamSha: string,
): Promise<void> {
  const { rootHandle, inFlightMeta, targetBranch, env } = params;
  const cwd = rootHandle.worktreePath;
  await runGitCommand({
    cwd,
    args: [
      'push',
      '--force-with-lease',
      'origin',
      `HEAD:refs/heads/${targetBranch}`,
    ],
    env,
  });
  const pushedCommitSha = (
    await runGitCommand({ cwd, args: ['rev-parse', 'HEAD'], env })
  ).stdout.trim();
  await writeHarnessMeta(rootHandle.gitDirPath, {
    ...inFlightMeta,
    baseRef: upstreamSha,
    baseBranch: resolvedBaseBranch,
    branchName: targetBranch,
    inFlightCommitAndPush: undefined,
  });
  updateWorktreeHandleInPlace(rootHandle, {
    baseRef: upstreamSha,
    baseBranch: resolvedBaseBranch,
    branchName: targetBranch,
    headRef: pushedCommitSha,
  });
}

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
  const scopeNode =
    ctx.scopeNode?.type === 'git:cow-worktree' ? ctx.scopeNode : undefined;
  const effectivePolicy =
    scopeNode !== undefined
      ? resolveEffectiveCheckpointPolicy(scopeNode)
      : undefined;
  const env = resolveCommitAndPushEnv(node, ctx);
  await gitWorktreeFlushCleanParentChanges(
    rootHandle,
    effectivePolicy?.excludeGlobs,
  );
  const preStepHeadSha = (
    await runGitCommand({ cwd, args: ['rev-parse', 'HEAD'], env })
  ).stdout.trim();
  const initialMeta = await readHarnessMeta(rootHandle.gitDirPath);
  const preStepBaseRef = initialMeta.baseRef;
  const targetBranch = node.branch(parsedInput);
  const commitMessage = node.message(parsedInput);
  const inFlightMeta: HarnessMetaRecord = {
    ...initialMeta,
    inFlightCommitAndPush: { preStepHeadSha, preStepBaseRef, targetBranch },
  };
  await writeHarnessMeta(rootHandle.gitDirPath, inFlightMeta);
  const phaseParams: SquashRebasePhaseParams = {
    rootHandle,
    inFlightMeta,
    preStepHeadSha,
    preStepBaseRef,
    targetBranch,
    commitMessage,
    env,
  };
  try {
    const [resolvedBaseBranch, upstreamSha] =
      await squashAndRebaseOntoUpstream(phaseParams);
    const verifyCheck = scopeNode?.reconcileStrategy?.verifyWith;
    if (verifyCheck !== undefined) {
      const checkOutcome = await evaluateWorktreeCheck(verifyCheck, ctx);
      if (!checkOutcome.ok) {
        throw new Error(
          `Reconcile verification check '${verifyCheck.id}' failed: ${checkOutcome.deficits.join('; ')}`,
        );
      }
    }
    await pushAndFinalizeRootLineage(
      phaseParams,
      resolvedBaseBranch,
      upstreamSha,
    );
  } catch (err) {
    await rollbackFailedCommitAndPush(rootHandle, inFlightMeta, env);
    throw err;
  }
}
