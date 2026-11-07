import type { IncomingMessage } from 'node:http';
import { Webhooks } from '@octokit/webhooks';
import { DEFAULT_MAX_GITHUB_WEBHOOK_BODY_BYTES } from '../../builders/internal/github-builder-defaults.constants.js';

/**
 * Verifies a GitHub `X-Hub-Signature-256` header against a raw webhook payload using `@octokit/webhooks`.
 *
 * Delegates HMAC-SHA256 verification to `Webhooks.verify(payload, signature)` and returns `false`
 * when `signatureHeader` is missing, malformed, or does not match.
 *
 * @param {Buffer}             rawBody          - Raw HTTP request body bytes.
 * @param {string | undefined} signatureHeader  - Value of the `X-Hub-Signature-256` header.
 * @param {Webhooks | string}  webhooksOrSecret - `@octokit/webhooks` instance or resolved secret string.
 *
 * @returns {Promise<boolean>} True when `signatureHeader` passes `@octokit/webhooks` verification.
 */
export async function verifyGithubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  webhooksOrSecret: Webhooks | string,
): Promise<boolean> {
  if (
    rawBody.length === 0 ||
    typeof signatureHeader !== 'string' ||
    !signatureHeader.startsWith('sha256=')
  ) {
    return false;
  }
  const webhooks =
    typeof webhooksOrSecret === 'string'
      ? new Webhooks({ secret: webhooksOrSecret })
      : webhooksOrSecret;
  try {
    return await webhooks.verify(rawBody.toString('utf8'), signatureHeader);
  } catch {
    return false;
  }
}

/**
 * Determines whether an incoming GitHub webhook event matches the stream node's event and repo filters.
 *
 * Matches both bare event names (`'pull_request'`) and action-qualified event names (`'pull_request.closed'`).
 *
 * @param {string | undefined}                eventHeader  - Value of the `X-GitHub-Event` HTTP header.
 * @param {Readonly<Record<string, unknown>>} payload      - Parsed JSON webhook delivery payload.
 * @param {object}                            filterConfig - Subscribed event set and optional repository filter.
 *
 * @returns {boolean} True when the delivery matches both the subscribed events and optional repository slug.
 */
export function matchesGithubWebhookFilter(
  eventHeader: string | undefined,
  payload: Readonly<Record<string, unknown>>,
  filterConfig: {
    readonly subscribedEvents: ReadonlySet<string>;
    readonly repo?: string;
  },
): boolean {
  if (typeof eventHeader !== 'string' || eventHeader.length === 0) {
    return false;
  }
  const action = payload['action'];
  const qualifiedEvent = typeof action === 'string' ? `${eventHeader}.${action}` : eventHeader;
  const eventMatched =
    filterConfig.subscribedEvents.has(eventHeader) ||
    filterConfig.subscribedEvents.has(qualifiedEvent);
  if (!eventMatched) {
    return false;
  }
  if (filterConfig.repo !== undefined) {
    const repoObj = payload['repository'];
    if (typeof repoObj !== 'object' || repoObj === null) {
      return false;
    }
    const fullName = (repoObj as Readonly<Record<string, unknown>>)['full_name'];
    if (fullName !== filterConfig.repo) {
      return false;
    }
  }
  return true;
}

/**
 * Reads a Node `IncomingMessage` body up to `maxBytes`, returning `undefined` if the limit is exceeded.
 *
 * Pauses the stream and discards buffered chunks immediately when accumulated bytes exceed `maxBytes`
 * so unbounded webhook payloads cannot exhaust process memory.
 *
 * @param {IncomingMessage} [req]                                            - Node HTTP incoming request stream.
 * @param {number}          [maxBytes=DEFAULT_MAX_GITHUB_WEBHOOK_BODY_BYTES] - Maximum allowed body size in bytes.
 *
 * @returns {Promise<Buffer | undefined>} Complete body buffer, or `undefined` if `maxBytes` was exceeded.
 */
export function readHttpRequestBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_GITHUB_WEBHOOK_BODY_BYTES,
): Promise<Buffer | undefined> {
  return new Promise<Buffer | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    req.on('data', (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        settled = true;
        chunks.length = 0;
        req.pause();
        resolve(undefined);
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
