/**
 * Branch reference descriptor nested inside a GitHub pull request webhook payload.
 *
 * Carries the branch reference name (`ref`) and optional commit SHA (`sha`).
 */
export interface GithubWebhookBranchRef {
  /** Branch reference name (such as `'fix/#42'` or `'main'`). */
  readonly ref: string;
  /** Optional commit SHA pointed to by the branch reference. */
  readonly sha?: string;
}

/**
 * Pull request payload nested inside a GitHub `pull_request` webhook event.
 *
 * Exposes merge status, merge commit SHA, and head/base branch references for stream filtering.
 */
export interface GithubWebhookPullRequestPayload {
  /** Optional pull request number. */
  readonly number?: number;
  /** True when the pull request was closed by merging. */
  readonly merged: boolean;
  /** Merge commit SHA produced when the pull request merged. */
  readonly merge_commit_sha: string;
  /** Source feature branch reference descriptor. */
  readonly head: GithubWebhookBranchRef;
  /** Target base branch reference descriptor. */
  readonly base: GithubWebhookBranchRef;
}

/**
 * Repository metadata nested inside a GitHub webhook delivery payload.
 *
 * Identifies the `owner/repo` slug used by `GithubWebhookStreamSource` for repository filtering.
 */
export interface GithubWebhookRepositoryPayload {
  /** Full `owner/repo` slug of the GitHub repository. */
  readonly full_name: string;
}

/**
 * Default typed GitHub webhook delivery event payload emitted by `github.webhookStream(...)`.
 *
 * Supports structured access to `action`, `repository.full_name`, and `pull_request` properties
 * while allowing additional webhook fields via index signature.
 */
export interface GithubWebhookEvent {
  /** Optional webhook action subtype (such as `'closed'` or `'opened'`). */
  readonly action?: string;
  /** Optional repository metadata descriptor. */
  readonly repository?: GithubWebhookRepositoryPayload;
  /** Pull request descriptor for `pull_request` webhook deliveries. */
  readonly pull_request: GithubWebhookPullRequestPayload;
  /** Additional arbitrary webhook event properties. */
  readonly [key: string]: unknown;
}
