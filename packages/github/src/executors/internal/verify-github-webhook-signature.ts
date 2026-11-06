import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Verifies a GitHub `X-Hub-Signature-256` HMAC-SHA256 header against a raw webhook payload body.
 *
 * Uses constant-time `timingSafeEqual` comparison to prevent timing side-channel attacks.
 *
 * @param {Buffer}                  rawBody         - Raw HTTP request body bytes.
 * @param {string | undefined}      signatureHeader - Value of the `X-Hub-Signature-256` header.
 * @param {string}                  secret          - Resolved webhook shared secret.
 *
 * @returns {boolean} True when `signatureHeader` matches the HMAC-SHA256 digest of `rawBody`.
 */
export function verifyGithubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const expectedSignature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(actualBuf, expectedBuf);
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
 * Reads the complete request body stream of a Node `IncomingMessage` into a single `Buffer`.
 *
 * Accumulates chunk buffers in-place without intermediate string conversions.
 *
 * @param {IncomingMessage} req - Node HTTP incoming request stream.
 *
 * @returns {Promise<Buffer>} Complete concatenated request body buffer.
 */
export function readHttpRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err: Error) => {
      reject(err);
    });
  });
}
