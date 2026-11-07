import { runGitCommand } from './git-cli-runner.js';

/**
 * Resolves `baseBranch` against `origin/main` before rebasing in `git.commitAndPush`.
 *
 * Falls back to `'main'` when a prerequisite branch was squash-merged and deleted, or throws if closed unmerged.
 *
 * @param {string} cwd                 - Worktree directory path.
 * @param {string} candidateBaseBranch - Recorded base branch name on the worktree handle.
 * @param {string} preStepBaseRef      - Recorded `baseRef` commit SHA prior to `commitAndPush`.
 *
 * @returns {Promise<string>} Resolved upstream branch name (`'main'` or active prerequisite branch).
 */
export async function resolveEffectiveBaseBranch(
  cwd: string,
  candidateBaseBranch: string,
  preStepBaseRef: string,
): Promise<string> {
  if (candidateBaseBranch === 'main') return 'main';
  const remoteBranch = await runGitCommand({
    cwd,
    args: ['rev-parse', '--verify', `refs/remotes/origin/${candidateBaseBranch}`],
    allowNonZeroExit: true,
  });
  const isAncestor = await runGitCommand({
    cwd,
    args: ['merge-base', '--is-ancestor', preStepBaseRef, 'refs/remotes/origin/main'],
    allowNonZeroExit: true,
  });
  const cherryRes = await runGitCommand({
    cwd,
    args: ['cherry', 'refs/remotes/origin/main', preStepBaseRef],
    allowNonZeroExit: true,
  });
  const allCommitsApplied = cherryRes.exitCode === 0 && !cherryRes.stdout.split('\n').some((line) => line.startsWith('+ '));
  if (isAncestor.exitCode === 0 || allCommitsApplied) return 'main';
  if (remoteBranch.exitCode === 0) return candidateBaseBranch;
  throw new Error(
    `Prerequisite branch '${candidateBaseBranch}' was closed or deleted on origin without merging into 'origin/main'.`,
  );
}
