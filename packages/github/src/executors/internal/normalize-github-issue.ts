import type { GithubIssueRecord } from '../github-issue-record.js';

/**
 * Extracts normalized string label names from a raw GitHub issue `labels` array.
 *
 * Accepts both string labels and `{ name: string }` label objects returned by the GitHub REST API.
 *
 * @param {unknown} rawLabels - Raw `labels` field from a GitHub issue payload.
 *
 * @returns {readonly string[]} Frozen array of label name strings.
 */
export function normalizeGithubIssueLabels(rawLabels: unknown): readonly string[] {
  if (!Array.isArray(rawLabels)) {
    return Object.freeze([]);
  }
  const labels: string[] = [];
  for (const entry of rawLabels) {
    if (typeof entry === 'string') {
      labels.push(entry);
    } else if (typeof entry === 'object' && entry !== null && 'name' in entry) {
      const nameVal = (entry as Readonly<Record<string, unknown>>)['name'];
      if (typeof nameVal === 'string') {
        labels.push(nameVal);
      }
    }
  }
  return Object.freeze(labels);
}

/**
 * Normalizes a raw GitHub REST API issue object into an immutable `GithubIssueRecord`.
 *
 * Preserves issue number, title, nullable body, normalized label names, state, and HTML URL.
 *
 * @param {unknown} rawIssue - Raw issue record returned by `/repos/:owner/:repo/issues`.
 * @param {string}  repo     - Repository slug used in diagnostic error messages.
 *
 * @returns {GithubIssueRecord} Frozen normalized GitHub issue record.
 *
 * @throws {Error} If `rawIssue` is not a valid object with numeric `number` and string `title`.
 */
export function normalizeGithubIssueRecord(rawIssue: unknown, repo: string): GithubIssueRecord {
  if (typeof rawIssue !== 'object' || rawIssue === null) {
    throw new Error(`Invalid GitHub issue payload from '${repo}': expected an object.`);
  }
  const record = rawIssue as Readonly<Record<string, unknown>>;
  const issueNumber = record['number'];
  const title = record['title'];
  if (typeof issueNumber !== 'number' || typeof title !== 'string') {
    throw new Error(
      `Invalid GitHub issue payload from '${repo}': missing numeric 'number' or string 'title'.`,
    );
  }
  const rawBody = record['body'];
  const rawState = record['state'];
  const rawHtmlUrl = record['html_url'] ?? record['htmlUrl'];
  return Object.freeze<GithubIssueRecord>({
    number: issueNumber,
    title,
    body: typeof rawBody === 'string' ? rawBody : null,
    labels: normalizeGithubIssueLabels(record['labels']),
    state: typeof rawState === 'string' ? rawState : undefined,
    htmlUrl: typeof rawHtmlUrl === 'string' ? rawHtmlUrl : undefined,
  });
}

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

/**
 * Parses a positive integer GitHub issue number from an external item key such as `'#42'` or `'42'`.
 *
 * Strips any leading `'#'` prefix and validates that the remaining value is a positive integer.
 *
 * @param {string} itemKey - External tracker item key (`'#42'` or `'42'`).
 * @param {string} repo    - Repository slug used in diagnostic error messages.
 *
 * @returns {number} Parsed positive integer GitHub issue number.
 *
 * @throws {Error} If `itemKey` does not parse to a positive integer.
 */
export function parseGithubIssueNumber(itemKey: string, repo: string): number {
  const rawNumber = itemKey.startsWith('#') ? itemKey.slice(1).trim() : itemKey.trim();
  const issueNumber = Number.parseInt(rawNumber, 10);
  if (rawNumber.length === 0 || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      `Invalid itemKey '${itemKey}' in GithubIssuesTrackerAdapter.setExternalState for '${repo}'.`,
    );
  }
  return issueNumber;
}
