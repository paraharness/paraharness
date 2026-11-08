import type { GithubIssuesTrackerNode, GithubWebhookStreamNode } from '@paraharness/core';
import type { GithubIssueRecord } from '../executors/github-issue-record.js';
import type { GithubWebhookEvent } from '../executors/github-webhook-event.js';
import type { GithubCreateOrUpdatePrBuilder } from './github-create-or-update-pr-builder.js';
import type { GithubCreateOrUpdatePrOptions } from './github-create-or-update-pr-options.js';
import type { GithubIssuesOptions } from './github-issues-options.js';
import type { GithubWebhookStreamOptions } from './github-webhook-stream-options.js';

/**
 * Public DSL builder namespace for `@paraharness/github` (`github.*`).
 *
 * Exposes declarative factories for GitHub Issues trackers (`github.issues`),
 * webhook event streams (`github.webhookStream`), and pull-request domain steps (`github.createOrUpdatePr`).
 */
export interface GithubNamespace {
  /**
   * Creates a passive `GithubIssuesTrackerNode` polling open issues from a GitHub repository.
   *
   * Supports optional label filtering and bidirectional issue state synchronization via `TrackerAdapter`.
   *
   * @template TExternal      External issue record type (defaults to `GithubIssueRecord`).
   * @template TExternalState External tracker state string union.
   *
   * @param {GithubIssuesOptions} options - Repository slug, token, and optional label filters.
   *
   * @returns {GithubIssuesTrackerNode<TExternal, TExternalState>} Frozen GitHub Issues tracker AST node.
   */
  issues<TExternal = GithubIssueRecord, TExternalState extends string = string>(
    options: GithubIssuesOptions,
  ): GithubIssuesTrackerNode<TExternal, TExternalState>;

  /**
   * Creates a passive `GithubWebhookStreamNode` listening for signed GitHub webhook events.
   *
   * Defaults `port` to `3000` and `path` to `'/webhooks/github'` when omitted in `options`.
   *
   * @template TEvent Webhook event payload type (defaults to `GithubWebhookEvent`).
   *
   * @param {GithubWebhookStreamOptions} options - Webhook listener port, path, secret, and subscribed events.
   *
   * @returns {GithubWebhookStreamNode<TEvent>} Frozen GitHub webhook stream source AST node.
   */
  webhookStream<TEvent = GithubWebhookEvent>(
    options: GithubWebhookStreamOptions,
  ): GithubWebhookStreamNode<TEvent>;

  /**
   * Creates a fluent `GithubCreateOrUpdatePrBuilder` domain step for opening or updating a pull request.
   *
   * Projects the head branch, optional base branch, title, and body from the step input payload.
   *
   * @template TIn     Validated step input payload type.
   * @template TOut    Validated step output payload type.
   * @template THandle Runtime handle type of the enclosing isolation scope.
   *
   * @param {string}                             id      - Unique step node identifier.
   * @param {GithubCreateOrUpdatePrOptions<TIn>} options - Repository, token, and PR field projections.
   *
   * @returns {GithubCreateOrUpdatePrBuilder<TIn, TOut, THandle>} Fluent pull-request step builder.
   */
  createOrUpdatePr<TIn = unknown, TOut = unknown, THandle = unknown>(
    id: string,
    options: GithubCreateOrUpdatePrOptions<TIn>,
  ): GithubCreateOrUpdatePrBuilder<TIn, TOut, THandle>;
}
