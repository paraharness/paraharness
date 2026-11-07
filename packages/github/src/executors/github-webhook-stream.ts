import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Webhooks } from '@octokit/webhooks';
import type {
  GithubWebhookStreamNode,
  RuntimeDriverContext,
  StreamSource,
  StreamSubscriptionHandle,
} from '@harness-dsl/core';
import {
  DEFAULT_GITHUB_WEBHOOK_PATH,
  DEFAULT_GITHUB_WEBHOOK_PORT,
} from '../builders/internal/github-builder-defaults.constants.js';
import { dispatchGithubWebhookRequest } from './internal/dispatch-github-webhook-request.js';
import { resolveRequiredGithubSecret } from './internal/resolve-required-github-secret.js';

/**
 * Runtime `StreamSource` implementation for `GithubWebhookStreamNode` (`github:webhook-stream`).
 *
 * Listens for HTTP POST webhook deliveries, enforces a 10 MiB body limit (`413`), verifies
 * `X-Hub-Signature-256` via `@octokit/webhooks`, filters by event/repo, and invokes `onEvent`.
 *
 * @template TEvent Webhook event payload type.
 */
export class GithubWebhookStreamSource<TEvent = unknown> implements StreamSource<TEvent> {
  /** Passive webhook stream AST node. */
  private readonly node: GithubWebhookStreamNode<TEvent>;

  /** Runtime driver context used to resolve `node.secret`. */
  private readonly ctx: RuntimeDriverContext;

  /** Pre-indexed set of subscribed event names for $O(1)$ lookup. */
  private readonly subscribedEvents: ReadonlySet<string>;

  /** Active Node HTTP server when subscribed. */
  private server: Server | undefined;

  /** Bound TCP port once the HTTP server is listening. */
  private boundPort: number | undefined;

  /**
   * Initializes a new `GithubWebhookStreamSource` for `node` and `ctx`.
   *
   * Pre-indexes `node.events` into a `Set` at construction time per Rule 4.2.
   *
   * @param {GithubWebhookStreamNode<TEvent>} node - Passive GitHub webhook stream AST node.
   * @param {RuntimeDriverContext}            ctx  - Runtime driver context.
   */
  constructor(node: GithubWebhookStreamNode<TEvent>, ctx: RuntimeDriverContext) {
    this.node = node;
    this.ctx = ctx;
    this.subscribedEvents = new Set<string>(node.events);
  }

  /**
   * Returns the currently bound local TCP listener port when the webhook server is active.
   *
   * Useful when `node.port` is configured as `0` for ephemeral port assignment in tests.
   *
   * @returns {number | undefined} Bound TCP port number, or `undefined` when not listening.
   */
  getBoundPort(): number | undefined {
    return this.boundPort;
  }

  /**
   * Starts the local HTTP webhook listener and subscribes `onEvent` to verified matching deliveries.
   *
   * Resolves `node.secret` via `ctx.resolveEnv`, initializes `@octokit/webhooks`, and binds to `127.0.0.1`.
   *
   * @param {(event: TEvent) => Promise<void>} onEvent - Async callback invoked for each verified matching webhook event.
   *
   * @returns {Promise<StreamSubscriptionHandle>} Handle with `.close()` to shut down the HTTP listener.
   *
   * @throws {Error} If already subscribed, secret resolution fails, or port binding fails.
   */
  async subscribe(onEvent: (event: TEvent) => Promise<void>): Promise<StreamSubscriptionHandle> {
    if (this.server !== undefined) {
      throw new Error(
        `GithubWebhookStreamSource ('${this.node.repo ?? '*'}') is already subscribed.`,
      );
    }
    const secret = resolveRequiredGithubSecret(
      this.node.secret,
      (val) => this.ctx.resolveEnv(val),
      `github:webhook-stream (${this.node.repo ?? '*'})`,
    );
    const webhooks = new Webhooks({ secret });
    const targetPort = this.node.port ?? DEFAULT_GITHUB_WEBHOOK_PORT;
    const targetPath = this.node.path ?? DEFAULT_GITHUB_WEBHOOK_PATH;

    const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      void dispatchGithubWebhookRequest(req, res, {
        webhooks,
        targetPath,
        subscribedEvents: this.subscribedEvents,
        repo: this.node.repo,
        onEvent,
      });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(targetPort, '127.0.0.1', () => {
        httpServer.removeListener('error', reject);
        resolve();
      });
    });

    this.server = httpServer;
    const addressInfo = httpServer.address();
    if (typeof addressInfo === 'object' && addressInfo !== null) {
      this.boundPort = addressInfo.port;
    }

    return Object.freeze<StreamSubscriptionHandle>({
      close: (): Promise<void> => this.closeHttpServer(httpServer),
    });
  }

  /**
   * Idempotently closes `httpServer` and clears `this.server` and `this.boundPort`.
   *
   * No-ops if `httpServer` is no longer the active listener instance.
   *
   * @param {Server} httpServer - Node HTTP server instance to shut down.
   *
   * @returns {Promise<void>} Resolves once the HTTP server has closed.
   */
  private async closeHttpServer(httpServer: Server): Promise<void> {
    if (this.server !== httpServer) {
      return;
    }
    this.server = undefined;
    this.boundPort = undefined;
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err?: Error) => {
        if (err !== undefined) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}
