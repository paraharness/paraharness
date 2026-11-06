import type {
  GithubIssuesTrackerNode,
  RuntimeDriverContext,
  TrackerAdapter,
} from '@harness-dsl/core';
import { defaultGithubHttpTransport } from './default-github-http-transport.constants.js';
import type { GithubHttpTransport } from './github-http-transport.js';
import type { GithubIssueRecord } from './github-issue-record.js';
import {
  normalizeGithubIssueRecord,
  resolveRequiredGithubSecret,
} from './internal/normalize-github-issue.js';

/**
 * Runtime `TrackerAdapter` implementation for `GithubIssuesTrackerNode` (`github:issues`).
 *
 * Polls open issues from `/repos/:owner/:repo/issues` with optional label filters and
 * synchronizes lane lifecycle state transitions back to `/repos/:owner/:repo/issues/:number/labels`.
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
   * Polls open issues from `/repos/${repo}/issues` and normalizes them into `GithubIssueRecord` items.
   *
   * Appends the `labels` query parameter when `node.labels` is configured and non-empty.
   *
   * @returns {Promise<readonly GithubIssueRecord[]>} Frozen array of normalized GitHub issue records.
   */
  async poll(): Promise<readonly GithubIssueRecord[]> {
    const token = resolveRequiredGithubSecret(
      this.node.token,
      (val) => this.ctx.resolveEnv(val),
      `github:issues (${this.node.repo})`,
    );
    const hasLabels = this.node.labels !== undefined && this.node.labels.length > 0;
    const labelsParam = hasLabels
      ? `&labels=${encodeURIComponent(this.node.labels.join(','))}`
      : '';
    const path = `/repos/${this.node.repo}/issues?state=open${labelsParam}`;
    const rawIssues = await this.transport.request<readonly unknown[]>('GET', path, { token });
    if (!Array.isArray(rawIssues)) {
      throw new Error(`Unexpected non-array response polling issues for '${this.node.repo}'.`);
    }
    const normalized: GithubIssueRecord[] = [];
    for (const rawIssue of rawIssues) {
      normalized.push(normalizeGithubIssueRecord(rawIssue, this.node.repo));
    }
    return Object.freeze(normalized);
  }

  /**
   * Updates the external label state on `/repos/${repo}/issues/${issueNumber}/labels`.
   *
   * Strips any leading `'#'` prefix from `itemKey` before constructing the issue labels endpoint path.
   *
   * @param {string}         itemKey - Issue key such as `'#42'` or `'42'`.
   * @param {TExternalState} state   - Target external state label to apply.
   *
   * @returns {Promise<void>} Resolves once the GitHub issue labels have been updated.
   */
  async setExternalState(itemKey: string, state: TExternalState): Promise<void> {
    const token = resolveRequiredGithubSecret(
      this.node.token,
      (val) => this.ctx.resolveEnv(val),
      `github:issues (${this.node.repo})`,
    );
    const issueNumber = itemKey.startsWith('#') ? itemKey.slice(1).trim() : itemKey.trim();
    if (issueNumber.length === 0) {
      throw new Error(
        `Invalid itemKey '${itemKey}' in GithubIssuesTrackerAdapter.setExternalState for '${this.node.repo}'.`,
      );
    }
    await this.transport.request(
      'PUT',
      `/repos/${this.node.repo}/issues/${issueNumber}/labels`,
      {
        token,
        body: { labels: [state] },
      },
    );
  }
}
