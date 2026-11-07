import type { Octokit } from '@octokit/rest';
import { DEFAULT_GITHUB_ISSUES_PER_PAGE } from '../../builders/internal/github-builder-defaults.constants.js';
import type { GithubIssueRecord } from '../github-issue-record.js';
import type { GithubRepoCoordinates } from './github-repo-coordinates.js';
import { isGithubPullRequestIssueItem, normalizeGithubIssueRecord } from './normalize-github-issue.js';

/**
 * Parameters for paginating open GitHub issues via `pollOpenGithubIssues`.
 *
 * Carries the authenticated `Octokit` client, parsed repository coordinates, full slug, and optional label list.
 */
export interface PollOpenGithubIssuesParams {
  /** Authenticated `@octokit/rest` client instance. */
  readonly octokit: Octokit;
  /** Parsed owner and repository coordinates. */
  readonly coordinates: GithubRepoCoordinates;
  /** Full `owner/repo` slug used in diagnostic error messages. */
  readonly repoSlug: string;
  /** Optional label names used to filter open issues. */
  readonly labels?: readonly string[];
}

/**
 * Fetches a single 100-item page of open issues from `/repos/:owner/:repo/issues`.
 *
 * Avoids conditional property spreads so request parameter objects remain monomorphic.
 *
 * @param {PollOpenGithubIssuesParams} params       - Client and repository parameters.
 * @param {string | undefined}         labelsFilter - Optional comma-joined label filter string.
 * @param {number}                     page         - 1-based page number to fetch.
 *
 * @returns {Promise<readonly unknown[]>} Raw issue items returned for `page`.
 *
 * @throws {Error} If the GitHub REST response payload is not an array.
 */
async function fetchOpenGithubIssuesPage(
  params: PollOpenGithubIssuesParams,
  labelsFilter: string | undefined,
  page: number,
): Promise<readonly unknown[]> {
  const response =
    labelsFilter !== undefined
      ? await params.octokit.rest.issues.listForRepo({
          owner: params.coordinates.owner,
          repo: params.coordinates.repo,
          state: 'open',
          labels: labelsFilter,
          per_page: DEFAULT_GITHUB_ISSUES_PER_PAGE,
          page,
        })
      : await params.octokit.rest.issues.listForRepo({
          owner: params.coordinates.owner,
          repo: params.coordinates.repo,
          state: 'open',
          per_page: DEFAULT_GITHUB_ISSUES_PER_PAGE,
          page,
        });
  const rawIssues: unknown = response.data;
  if (!Array.isArray(rawIssues)) {
    throw new Error(`Unexpected non-array response polling issues for '${params.repoSlug}'.`);
  }
  return rawIssues;
}

/**
 * Paginates all open GitHub issues across 100-item pages and normalizes non-PR issue records.
 *
 * Filters out pull request items returned by `/repos/:owner/:repo/issues` and freezes the result list.
 *
 * @param {PollOpenGithubIssuesParams} params - Authenticated Octokit client, repo coordinates, and optional labels.
 *
 * @returns {Promise<readonly GithubIssueRecord[]>} Frozen array of normalized open GitHub issues.
 *
 * @throws {Error} If any page returns a non-array payload or malformed issue record.
 */
export async function pollOpenGithubIssues(
  params: PollOpenGithubIssuesParams,
): Promise<readonly GithubIssueRecord[]> {
  const hasLabels = params.labels !== undefined && params.labels.length > 0;
  const labelsFilter = hasLabels ? params.labels.join(',') : undefined;
  const normalized: GithubIssueRecord[] = [];
  let page = 1;

  while (true) {
    const rawIssues = await fetchOpenGithubIssuesPage(params, labelsFilter, page);
    for (const rawIssue of rawIssues) {
      if (!isGithubPullRequestIssueItem(rawIssue)) {
        normalized.push(normalizeGithubIssueRecord(rawIssue, params.repoSlug));
      }
    }
    if (rawIssues.length < DEFAULT_GITHUB_ISSUES_PER_PAGE) {
      break;
    }
    page += 1;
  }

  return Object.freeze(normalized);
}
