import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Webhooks } from '@octokit/webhooks';
import { matchesGithubWebhookFilter } from './matches-github-webhook-filter.js';
import { readHttpRequestBody } from './read-http-request-body.js';
import { verifyGithubWebhookSignature } from './verify-github-webhook-signature.js';

/**
 * Configuration parameters for dispatching an incoming HTTP request in `dispatchGithubWebhookRequest`.
 *
 * Bundles the `@octokit/webhooks` verifier, route path, event/repo filter configuration, and `onEvent` callback.
 *
 * @template TEvent Webhook event payload type.
 */
export interface DispatchGithubWebhookRequestParams<TEvent = unknown> {
  /** Initialized `@octokit/webhooks` instance configured with the resolved secret. */
  readonly webhooks: Webhooks;
  /** Expected HTTP route path (such as `'/webhooks/github'`). */
  readonly targetPath: string;
  /** Pre-indexed set of subscribed GitHub webhook event names. */
  readonly subscribedEvents: ReadonlySet<string>;
  /** Optional GitHub repository slug in `'owner/repo'` format. */
  readonly repo?: string;
  /** Async callback invoked for each verified matching webhook event. */
  readonly onEvent: (event: TEvent) => Promise<void>;
}

/**
 * Writes a JSON response with `statusCode` and `body` to `res`.
 *
 * Centralizes `Content-Type: application/json` header formatting for webhook HTTP responses.
 *
 * @param {ServerResponse}                  res        - Outgoing HTTP server response.
 * @param {number}                          statusCode - HTTP status code to send.
 * @param {Readonly<Record<string, unknown>>} body     - JSON-serializable response payload.
 *
 * @returns {void}
 */
function sendJsonWebhookResponse(
  res: ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Extracts the first string header value from a Node HTTP header entry.
 *
 * Handles both single string headers and string array headers.
 *
 * @param {string | string[] | undefined} headerValue - Raw header value from `req.headers`.
 *
 * @returns {string | undefined} Extracted string header value, or `undefined`.
 */
function extractFirstHeaderString(headerValue: string | string[] | undefined): string | undefined {
  return Array.isArray(headerValue) ? headerValue[0] : headerValue;
}

/**
 * Parses a raw UTF-8 webhook buffer into a non-null JSON object record, or returns `undefined`.
 *
 * Returns `undefined` when JSON parsing fails or the parsed root value is not a non-null object.
 *
 * @param {Buffer} rawBody - Raw HTTP request body buffer.
 *
 * @returns {Readonly<Record<string, unknown>> | undefined} Parsed JSON object or `undefined`.
 */
function parseWebhookJsonObject(rawBody: Buffer): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
}

/**
 * Validates and dispatches a single incoming HTTP webhook delivery request.
 *
 * Responds with `404` on path mismatch, `413` on oversized body, `401` on invalid signature,
 * `400` on invalid JSON, `202` when filtered out, `200` once `onEvent` completes, and `500` on error.
 *
 * @template TEvent Webhook event payload type.
 *
 * @param {IncomingMessage}                            req    - Incoming HTTP request.
 * @param {ServerResponse}                             res    - Outgoing HTTP response.
 * @param {DispatchGithubWebhookRequestParams<TEvent>} params - Verifier, route, filter, and callback config.
 *
 * @returns {Promise<void>} Resolves once the HTTP response is finalized.
 */
export async function dispatchGithubWebhookRequest<TEvent = unknown>(
  req: IncomingMessage,
  res: ServerResponse,
  params: DispatchGithubWebhookRequestParams<TEvent>,
): Promise<void> {
  try {
    const requestPath = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || requestPath !== params.targetPath) {
      sendJsonWebhookResponse(res, 404, { error: 'Not Found' });
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
    const signature = extractFirstHeaderString(req.headers['x-hub-signature-256']);
    if (!(await verifyGithubWebhookSignature(rawBody, signature, params.webhooks))) {
      sendJsonWebhookResponse(res, 401, { error: 'Invalid X-Hub-Signature-256' });
      return;
    }
    const payloadRecord = parseWebhookJsonObject(rawBody);
    if (payloadRecord === undefined) {
      sendJsonWebhookResponse(res, 400, { error: 'Malformed JSON object payload' });
      return;
    }
    const eventHeader = extractFirstHeaderString(req.headers['x-github-event']);
    const matches = matchesGithubWebhookFilter(eventHeader, payloadRecord, {
      subscribedEvents: params.subscribedEvents,
      repo: params.repo,
    });
    if (!matches) {
      sendJsonWebhookResponse(res, 202, { delivered: false, reason: 'filtered' });
      return;
    }
    await params.onEvent(payloadRecord as TEvent);
    sendJsonWebhookResponse(res, 200, { delivered: true });
  } catch (err: unknown) {
    if (!res.headersSent) {
      sendJsonWebhookResponse(res, 500, {
        error: err instanceof Error ? err.message : 'Internal webhook handler error',
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}
