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
import { resolveRequiredGithubSecret } from './internal/normalize-github-issue.js';
import {
  matchesGithubWebhookFilter,
  readHttpRequestBody,
  verifyGithubWebhookSignature,
} from './internal/verify-github-webhook-signature.js';

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
      void this.handleHttpRequest(req, res, { webhooks, targetPath, onEvent });
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

    let closed = false;
    return Object.freeze<StreamSubscriptionHandle>({
      close: async (): Promise<void> => {
        if (closed) {
          return;
        }
        closed = true;
        if (this.server === httpServer) {
          this.server = undefined;
          this.boundPort = undefined;
        }
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err?: Error) => {
            if (err !== undefined) {
              reject(err);
              return;
            }
            resolve();
          });
        });
      },
    });
  }

  /**
   * Validates and dispatches a single incoming HTTP webhook delivery request.
   *
   * Responds with `404` on path mismatch, `413` on oversized body, `401` on invalid signature,
   * `400` on invalid JSON, `202` when filtered out, `200` once `onEvent` completes, and `500` on error.
   *
   * @param {IncomingMessage} req    - Incoming HTTP request.
   * @param {ServerResponse}  res    - Outgoing HTTP response.
   * @param {object}          config - Handler configuration with `@octokit/webhooks`, route path, and callback.
   *
   * @returns {Promise<void>} Resolves once the HTTP response is finalized.
   */
  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    config: {
      readonly webhooks: Webhooks;
      readonly targetPath: string;
      readonly onEvent: (event: TEvent) => Promise<void>;
    },
  ): Promise<void> {
    try {
      const requestPath = (req.url ?? '').split('?')[0];
      if (req.method !== 'POST' || requestPath !== config.targetPath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }
      const rawBody = await readHttpRequestBody(req);
      if (rawBody === undefined) {
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ error: 'Payload Too Large' }), () => {
          req.destroy();
        });
        return;
      }
      const sigHeader = req.headers['x-hub-signature-256'];
      const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      if (!(await verifyGithubWebhookSignature(rawBody, signature, config.webhooks))) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid X-Hub-Signature-256' }));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON payload' }));
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected JSON object payload' }));
        return;
      }
      const evHeaderRaw = req.headers['x-github-event'];
      const eventHeader = Array.isArray(evHeaderRaw) ? evHeaderRaw[0] : evHeaderRaw;
      const payloadRecord = parsed as Readonly<Record<string, unknown>>;
      if (
        !matchesGithubWebhookFilter(eventHeader, payloadRecord, {
          subscribedEvents: this.subscribedEvents,
          repo: this.node.repo,
        })
      ) {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ delivered: false, reason: 'filtered' }));
        return;
      }
      await config.onEvent(parsed as TEvent);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ delivered: true }));
    } catch (err: unknown) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : 'Internal webhook handler error',
          }),
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }
}
