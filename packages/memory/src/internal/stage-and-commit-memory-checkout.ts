import { MemoryHarnessError } from '../memory-harness-error.js';
import { execGitCommand } from './exec-git-command.js';
import {
  FALLBACK_GIT_AUTHOR_EMAIL,
  FALLBACK_GIT_AUTHOR_NAME,
} from './memory-protocol.constants.js';

/**
 * Parameter object for `stageAndCommitMemoryCheckout`.
 */
export interface StageAndCommitMemoryCheckoutParams {
  /** Absolute path to the `.memory` Git checkout directory. */
  readonly checkoutDir: string;
  /** Checkout-relative POSIX path to `memory.jsonl`. */
  readonly relLedgerPath: string;
  /** Checkout-relative POSIX path to `memory.meta.json`. */
  readonly relMetaPath: string;
  /** Commit message (`"memory(<repoId>): <opSummary>"`). */
  readonly commitMessage: string;
}

/**
 * Stages `<relLedgerPath>`, `<relMetaPath>`, and `.gitignore` inside `checkoutDir` and creates a
 * commit with the fallback author identity if `git status --porcelain` is non-empty (§8.2.2).
 *
 * @param {StageAndCommitMemoryCheckoutParams} params - Checkout directory, relative paths, and commit message.
 *
 * @returns {Promise<boolean>} `true` if a new commit was created; `false` if the staged tree was clean.
 *
 * @throws {MemoryHarnessError} With `'GIT_SYNC_FAILED'` if `git add` or `git commit` exits non-zero.
 */
export async function stageAndCommitMemoryCheckout(
  params: StageAndCommitMemoryCheckoutParams,
): Promise<boolean> {
  const addRes = await execGitCommand({
    cwd: params.checkoutDir,
    args: ['add', '--', params.relLedgerPath, params.relMetaPath, '.gitignore'],
  });
  if (addRes.exitCode !== 0) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to stage memory files in '${params.checkoutDir}': ${addRes.stderr}`,
      { checkoutDir: params.checkoutDir, stderr: addRes.stderr },
    );
  }
  const statusRes = await execGitCommand({
    cwd: params.checkoutDir,
    args: ['status', '--porcelain', '--', params.relLedgerPath, params.relMetaPath, '.gitignore'],
  });
  if (statusRes.exitCode !== 0) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to inspect git status in '${params.checkoutDir}': ${statusRes.stderr}`,
      { checkoutDir: params.checkoutDir, stderr: statusRes.stderr },
    );
  }
  if (statusRes.stdout.trim().length === 0) {
    return false;
  }
  const commitRes = await execGitCommand({
    cwd: params.checkoutDir,
    args: [
      '-c',
      `user.name=${FALLBACK_GIT_AUTHOR_NAME}`,
      '-c',
      `user.email=${FALLBACK_GIT_AUTHOR_EMAIL}`,
      'commit',
      '-m',
      params.commitMessage,
    ],
  });
  if (commitRes.exitCode !== 0) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to commit memory ledger in '${params.checkoutDir}': ${commitRes.stderr}`,
      { checkoutDir: params.checkoutDir, stderr: commitRes.stderr },
    );
  }
  return true;
}
