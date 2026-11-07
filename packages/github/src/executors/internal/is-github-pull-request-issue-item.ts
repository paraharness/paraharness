/**
 * Determines whether an item returned by GitHub's `/repos/:owner/:repo/issues` endpoint is a pull request.
 *
 * GitHub's issues REST endpoint returns both issues and pull requests; pull requests carry a
 * defined `pull_request` property and must be filtered out during issue polling.
 *
 * @param {unknown} rawIssue - Raw item returned by `/repos/:owner/:repo/issues`.
 *
 * @returns {boolean} True when `rawIssue` carries a defined `pull_request` property.
 */
export function isGithubPullRequestIssueItem(rawIssue: unknown): boolean {
  if (typeof rawIssue !== 'object' || rawIssue === null) {
    return false;
  }
  const record = rawIssue as Readonly<Record<string, unknown>>;
  return record['pull_request'] !== undefined && record['pull_request'] !== null;
}
