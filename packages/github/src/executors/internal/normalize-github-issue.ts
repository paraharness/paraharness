import type { EnvRef } from '@harness-dsl/core';
import type { GithubIssueRecord } from '../github-issue-record.js';

/**
 * Resolves a GitHub secret or token string from a literal value or symbolic `EnvRef`.
 *
 * Throws an actionable error if the referenced environment variable is unset or empty.
 *
 * @param {string | EnvRef}                              value      - Literal secret or symbolic `EnvRef`.
 * @param {(val: string | EnvRef) => string | undefined} resolveEnv - Runtime environment resolver callback.
 * @param {string}                                       contextId  - Diagnostic adapter or step identifier.
 *
 * @returns {string} Non-empty resolved secret or token string.
 */
export function resolveRequiredGithubSecret(
  value: string | EnvRef,
  resolveEnv: (val: string | EnvRef) => string | undefined,
  contextId: string,
): string {
  const resolved = resolveEnv(value);
  if (resolved === undefined || resolved.length === 0) {
    const keyDesc = typeof value === 'string' ? '<literal>' : value.key;
    throw new Error(
      `Missing required GitHub secret/token '${keyDesc}' while executing '${contextId}'.`,
    );
  }
  return resolved;
}

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
