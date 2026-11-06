import type { GithubWebhookStreamNode } from '@harness-dsl/core';
import type { GithubWebhookEvent } from '../executors/github-webhook-event.js';
import type { GithubWebhookStreamOptions } from './github-webhook-stream-options.js';
import {
  DEFAULT_GITHUB_WEBHOOK_PATH,
  DEFAULT_GITHUB_WEBHOOK_PORT,
} from './internal/github-builder-defaults.constants.js';

/**
 * Compiles a passive `GithubWebhookStreamNode` from `GithubWebhookStreamOptions` (`github.webhookStream`).
 *
 * Defaults `port` to `3000` and `path` to `'/webhooks/github'` when omitted and deeply freezes
 * the subscribed `events` list.
 *
 * @template TEvent Webhook event payload type (defaults to `GithubWebhookEvent`).
 *
 * @param {GithubWebhookStreamOptions} options - Webhook listener, secret, and event filter options.
 *
 * @returns {GithubWebhookStreamNode<TEvent>} Frozen passive GitHub webhook stream source AST node.
 */
export function createGithubWebhookStreamBuilder<TEvent = GithubWebhookEvent>(
  options: GithubWebhookStreamOptions,
): GithubWebhookStreamNode<TEvent> {
  if (!Array.isArray(options.events) || options.events.length === 0) {
    throw new Error('Invalid events in github.webhookStream: expected at least one event name.');
  }
  const resolvedPort = options.port ?? DEFAULT_GITHUB_WEBHOOK_PORT;
  const resolvedPath = options.path ?? DEFAULT_GITHUB_WEBHOOK_PATH;
  return Object.freeze<GithubWebhookStreamNode<TEvent>>({
    type: 'github:webhook-stream',
    repo: options.repo,
    port: resolvedPort,
    path: resolvedPath,
    secret: options.secret,
    events: Object.freeze([...options.events]),
  });
}
