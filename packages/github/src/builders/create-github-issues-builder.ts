import type { GithubIssuesTrackerNode } from '@metaharness/core';
import type { GithubIssueRecord } from '../executors/github-issue-record.js';
import type { GithubIssuesOptions } from './github-issues-options.js';

/**
 * Compiles a passive `GithubIssuesTrackerNode` from `GithubIssuesOptions` (`github.issues`).
 *
 * Validates that `options.repo` is a non-empty `owner/repo` slug and freezes the resulting
 * tracker AST node and optional label array.
 *
 * @template TExternal      External issue record type (defaults to `GithubIssueRecord`).
 * @template TExternalState External tracker state string union.
 *
 * @param {GithubIssuesOptions} options - Repository, token, and optional label filter configuration.
 *
 * @returns {GithubIssuesTrackerNode<TExternal, TExternalState>} Frozen passive GitHub Issues tracker AST node.
 *
 * @throws {Error} If `options.repo` is not a non-empty `'owner/repo'` slug.
 */
export function createGithubIssuesBuilder<
  TExternal = GithubIssueRecord,
  TExternalState extends string = string,
>(options: GithubIssuesOptions): GithubIssuesTrackerNode<TExternal, TExternalState> {
  if (
    typeof options.repo !== 'string' ||
    options.repo.trim().length === 0 ||
    !options.repo.includes('/')
  ) {
    throw new Error(
      `Invalid repo '${String(options.repo)}' in github.issues: expected non-empty 'owner/repo' slug.`,
    );
  }
  const frozenLabels =
    options.labels !== undefined ? Object.freeze([...options.labels]) : undefined;
  return Object.freeze<GithubIssuesTrackerNode<TExternal, TExternalState>>({
    type: 'github:issues',
    repo: options.repo,
    token: options.token,
    labels: frozenLabels,
  });
}
