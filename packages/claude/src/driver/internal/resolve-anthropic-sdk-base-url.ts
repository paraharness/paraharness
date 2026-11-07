/**
 * Derives the base URL passed to `new Anthropic({ baseURL })` from a `/v1/messages` endpoint URL.
 *
 * Strips a trailing `/v1/messages` or `/messages` path segment so `client.post('/v1/messages')` resolves cleanly.
 *
 * @param {string} endpointUrl - Full Anthropic `/v1/messages` endpoint URL.
 *
 * @returns {string} Normalized base URL for the `@anthropic-ai/sdk` client.
 */
export function resolveAnthropicSdkBaseUrl(endpointUrl: string): string {
  if (endpointUrl.endsWith('/v1/messages')) {
    return endpointUrl.slice(0, -'/v1/messages'.length);
  }
  if (endpointUrl.endsWith('/messages')) {
    return endpointUrl.slice(0, -'/messages'.length);
  }
  return endpointUrl;
}
