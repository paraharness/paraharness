import { Webhooks } from '@octokit/webhooks';

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
