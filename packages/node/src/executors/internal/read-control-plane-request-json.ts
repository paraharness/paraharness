import type { IncomingMessage } from 'node:http';

/**
 * Reads and parses the UTF-8 JSON body from an inbound HTTP control-plane `IncomingMessage` stream.
 *
 * Returns an empty object `{}` when the request body is empty or whitespace-only.
 *
 * @param {IncomingMessage} req - Inbound HTTP request stream.
 *
 * @returns {Promise<unknown>} Decoded JSON value from the request body.
 *
 * @throws {SyntaxError} If a non-empty request body is not valid JSON.
 */
export async function readControlPlaneRequestJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw.length > 0 ? JSON.parse(raw) : {};
}
