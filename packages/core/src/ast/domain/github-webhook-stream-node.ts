import type { BaseStreamSourceASTNode } from '../base/base-stream-source-ast-node.js';
import type { EnvRef } from '../env-ref.js';

/**
 * Passive AST node configuring a GitHub webhook event stream source (`github.webhookStream`).
 *
 * Verifies incoming `X-Hub-Signature-256` HMAC signatures using `secret` and filters webhook
 * deliveries by `repo` and subscribed `events`.
 *
 * @template TEvent Raw webhook event payload type.
 */
export interface GithubWebhookStreamNode<TEvent = unknown>
  extends BaseStreamSourceASTNode<'github:webhook-stream', TEvent> {
  /** Optional GitHub repository slug in `owner/repo` format used to filter incoming events. */
  readonly repo?: string;
  /** Optional HTTP listener port (defaults to `3000`). */
  readonly port?: number;
  /** Optional HTTP webhook route path (defaults to `'/webhooks/github'`). */
  readonly path?: string;
  /** Webhook HMAC secret string or symbolic `EnvRef`. */
  readonly secret: string | EnvRef;
  /** Subscribed GitHub webhook event names (such as `'pull_request.closed'`). */
  readonly events: readonly string[];
}
