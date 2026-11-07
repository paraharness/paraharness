import type {
  GithubIssuesTrackerNode,
  RuntimeDriverContext,
  TrackerAdapter,
} from '@harness-dsl/core';
import { DEFAULT_GITHUB_ISSUES_PER_PAGE } from '../builders/internal/github-builder-defaults.constants.js';
import { defaultGithubHttpTransport } from './default-github-http-transport.constants.js';
import type { GithubHttpTransport } from './github-http-transport.js';
import type { GithubIssueRecord } from './github-issue-record.js';
import {
  createGithubOctokitClient,
  parseGithubRepoSlug,
} from './internal/create-github-octokit-client.js';
import {
  isGithubPullRequestIssueItem,
  normalizeGithubIssueRecord,
  resolveRequiredGithubSecret,
} from './internal/normalize-github-issue.js';

/**
 * Runtime `TrackerAdapter` implementation for `GithubIssuesTrackerNode` (`github:issues`).
 *
 * Polls open issues from `/repos/:owner/:repo/issues` across `per_page: 100` pages via `@octokit/rest`
 * (filtering out pull requests) and adds lifecycle state labels non-destructively via `issues.addLabels`.
 *
 * @template TExternalState External tracker state string union.
 */
export class GithubIssuesTrackerAdapter<TExternalState extends string = string>
  implements TrackerAdapter<GithubIssueRecord, TExternalState>
{
  /** Passive tracker AST node configuring repository slug, token, and optional labels. */
  private readonly node: GithubIssuesTrackerNode<GithubIssueRecord, TExternalState>;

  /** Runtime driver context used for late-bound `EnvRef` resolution. */
  private readonly ctx: RuntimeDriverContext;

  /** HTTP transport used to execute GitHub REST API requests. */
  private readonly transport: GithubHttpTransport;

  /**
   * Initializes a new `GithubIssuesTrackerAdapter` bound to `node`, `ctx`, and `transport`.
   *
   * Resolves `node.token` lazily on each `poll()` and `setExternalState()` call via `ctx.resolveEnv`.
   *
   * @param {GithubIssuesTrackerNode<GithubIssueRecord, TExternalState>} node                                   - Passive GitHub Issues tracker AST node.
   * @param {RuntimeDriverContext}                                       ctx                                    - Runtime driver context.
   * @param {GithubHttpTransport}                                        [transport=defaultGithubHttpTransport] - Pluggable GitHub HTTP transport.
   */
  constructor(
    node: GithubIssuesTrackerNode<GithubIssueRecord, TExternalState>,
    ctx: RuntimeDriverContext,
    transport: GithubHttpTransport = defaultGithubHttpTransport,
  ) {
    this.node = node;
    this.ctx = ctx;
    this.transport = transport;
  }

  /**
   * Polls open issues from `/repos/${repo}/issues` across 100-item pages and filters out pull requests.
   *
   * Uses `@octokit/rest` `issues.listForRepo` with `per_page: 100` and excludes entries with `pull_request`.
   *
   * @returns {Promise<readonly GithubIssueRecord[]>} Frozen array of normalized GitHub issue records.
   */
  async poll(): Promise<readonly GithubIssueRecord[]> {
    const token = resolveRequiredGithubSecret(
      this.node.token,
      (val) => this.ctx.resolveEnv(val),
      `github:issues (${this.node.repo})`,
    );
    const { owner, repo } = parseGithubRepoSlug(this.node.repo);
    const octokit = createGithubOctokitClient(token, this.transport);
    const hasLabels = this.node.labels !== undefined && this.node.labels.length > 0;
    const labelsFilter = hasLabels ? this.node.labels.join(',') : undefined;

    const normalized: GithubIssueRecord[] = [];
    let page = 1;
    while (true) {
      const response = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: 'open',
        ...(labelsFilter !== undefined ? { labels: labelsFilter } : {}),
        per_page: DEFAULT_GITHUB_ISSUES_PER_PAGE,
        page,
      });
      const rawIssues: unknown = response.data;
      if (!Array.isArray(rawIssues)) {
        throw new Error(`Unexpected non-array response polling issues for '${this.node.repo}'.`);
      }
      for (const rawIssue of rawIssues) {
        if (!isGithubPullRequestIssueItem(rawIssue)) {
          normalized.push(normalizeGithubIssueRecord(rawIssue, this.node.repo));
        }
      }
      if (rawIssues.length < DEFAULT_GITHUB_ISSUES_PER_PAGE) {
        break;
      }
      page += 1;
    }
    return Object.freeze(normalized);
  }

  /**
   * Adds the target external state label non-destructively via `@octokit/rest` `issues.addLabels`.
   *
   * Strips any leading `'#'` prefix from `itemKey` and preserves existing non-state issue labels.
   *
   * @param {string}         itemKey - Issue key such as `'#42'` or `'42'`.
   * @param {TExternalState} state   - Target external state label to apply.
   *
   * @returns {Promise<void>} Resolves once the GitHub issue label has been added.
   */
  async setExternalState(itemKey: string, state: TExternalState): Promise<void> {
    const token = resolveRequiredGithubSecret(
      this.node.token,
      (val) => this.ctx.resolveEnv(val),
      `github:issues (${this.node.repo})`,
    );
    const rawNumber = itemKey.startsWith('#') ? itemKey.slice(1).trim() : itemKey.trim();
    const issueNumber = Number.parseInt(rawNumber, 10);
    if (rawNumber.length === 0 || !Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(
        `Invalid itemKey '${itemKey}' in GithubIssuesTrackerAdapter.setExternalState for '${this.node.repo}'.`,
      );
    }
    const { owner, repo } = parseGithubRepoSlug(this.node.repo);
    const octokit = createGithubOctokitClient(token, this.transport);
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [state],
    });
  }
}
