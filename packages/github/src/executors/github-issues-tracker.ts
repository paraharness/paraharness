import type {
  GithubIssuesTrackerNode,
  RuntimeDriverContext,
  TrackerAdapter,
} from '@metaharness/core';
import { defaultGithubHttpTransport } from './default-github-http-transport.constants.js';
import type { GithubHttpTransport } from './github-http-transport.js';
import type { GithubIssueRecord } from './github-issue-record.js';
import { createGithubOctokitClient } from './internal/create-github-octokit-client.js';
import { parseGithubIssueNumber } from './internal/parse-github-issue-number.js';
import { parseGithubRepoSlug } from './internal/parse-github-repo-slug.js';
import { pollOpenGithubIssues } from './internal/poll-open-github-issues.js';
import { resolveRequiredGithubSecret } from './internal/resolve-required-github-secret.js';

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
   *
   * @throws {Error} If token resolution fails, the repo slug is invalid, or the API payload is malformed.
   */
  async poll(): Promise<readonly GithubIssueRecord[]> {
    const token = resolveRequiredGithubSecret(
      this.node.token,
      (val) => this.ctx.resolveEnv(val),
      `github:issues (${this.node.repo})`,
    );
    const coordinates = parseGithubRepoSlug(this.node.repo);
    const octokit = createGithubOctokitClient(token, this.transport);
    return pollOpenGithubIssues({
      octokit,
      coordinates,
      repoSlug: this.node.repo,
      labels: this.node.labels,
    });
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
   *
   * @throws {Error} If token resolution fails, `itemKey` is not a positive integer, or repo slug is invalid.
   */
  async setExternalState(itemKey: string, state: TExternalState): Promise<void> {
    const token = resolveRequiredGithubSecret(
      this.node.token,
      (val) => this.ctx.resolveEnv(val),
      `github:issues (${this.node.repo})`,
    );
    const issueNumber = parseGithubIssueNumber(itemKey, this.node.repo);
    const coordinates = parseGithubRepoSlug(this.node.repo);
    const octokit = createGithubOctokitClient(token, this.transport);
    await octokit.rest.issues.addLabels({
      owner: coordinates.owner,
      repo: coordinates.repo,
      issue_number: issueNumber,
      labels: [state],
    });
  }
}
