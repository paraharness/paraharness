import type { ComputeWorktreeStatusOptions } from './compute-worktree-status-options.js';
import { runGitCommand } from './git-cli-runner.js';
import { parsePorcelainV2Records } from './porcelain-v2-parser.js';
import type { WorktreeStatusSnapshot } from './worktree-status-snapshot.js';

/**
 * Computes the porcelain v2 status snapshot for `worktreePath` (`git status --porcelain=v2 -z --no-renames --untracked-files=all`).
 *
 * Optionally enables `--ignored=matching` when scanning for files hidden behind a `.gitignore` mutation.
 *
 * @param {string}                       worktreePath - Worktree directory path to scan.
 * @param {ComputeWorktreeStatusOptions} [options]    - Optional exclusion globs and ignored-matching flags.
 *
 * @returns {Promise<WorktreeStatusSnapshot>} Structured status map, untracked set, deleted set, and ignored paths.
 */
export async function gitCheckpointStatusMap(
  worktreePath: string,
  options?: ComputeWorktreeStatusOptions,
): Promise<WorktreeStatusSnapshot> {
  const args = [
    'status',
    '--porcelain=v2',
    '-z',
    '--no-renames',
    '--untracked-files=all',
  ];
  if (options?.includeMatchingIgnored) {
    args.push('--ignored=matching');
  }
  const statusResult = await runGitCommand({ cwd: worktreePath, args });
  return parsePorcelainV2Records(worktreePath, statusResult.stdout, options);
}
