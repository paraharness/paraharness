import type { EnvRef } from '@metaharness/core';

/**
 * Configuration options for the GitHub webhook event stream builder (`github.webhookStream`).
 *
 * Defines the optional repository filter, local HTTP listener port and route path,
 * HMAC-SHA256 webhook secret, and subscribed GitHub webhook event names.
 */
export interface GithubWebhookStreamOptions {
  /** Optional GitHub repository slug in `owner/repo` format used to filter webhook deliveries. */
  readonly repo?: string;
  /** Optional local TCP listener port (defaults to `3000`). */
  readonly port?: number;
  /** Optional HTTP route path for incoming webhook deliveries (defaults to `'/webhooks/github'`). */
  readonly path?: string;
  /** GitHub webhook HMAC-SHA256 secret string or symbolic `M.env(...)` reference. */
  readonly secret: string | EnvRef;
  /** Subscribed GitHub webhook event names (such as `'pull_request.closed'`). */
  readonly events: readonly string[];
}
