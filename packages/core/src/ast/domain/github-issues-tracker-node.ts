import type { BaseTrackerASTNode } from '../base/base-tracker-ast-node.js';
import type { EnvRef } from '../env-ref.js';

/**
 * Passive AST node configuring a GitHub Issues tracker adapter (`github.issues`).
 *
 * Polls open issues matching `labels` in `repo` and mirrors lane lifecycle state transitions
 * back to GitHub issue labels and state.
 *
 * @template TExternal      Raw GitHub issue payload type.
 * @template TExternalState External issue state or label string union.
 */
export interface GithubIssuesTrackerNode<
  TExternal = unknown,
  TExternalState extends string = string,
> extends BaseTrackerASTNode<'github:issues', TExternal, TExternalState> {
  /** GitHub repository slug in `owner/repo` format. */
  readonly repo: string;
  /** GitHub API personal access token or symbolic `EnvRef`. */
  readonly token: string | EnvRef;
  /** Optional label filter applied when polling issues. */
  readonly labels?: readonly string[];
}
