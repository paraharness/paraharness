/**
 * Derives the base URL passed to `new OpenAI({ baseURL })` from a `/v1/responses` endpoint URL.
 *
 * Strips a trailing `/responses` path segment so `client.post('/responses')` targets `/v1/responses`.
 *
 * @param {string} endpointUrl - Full OpenAI `/v1/responses` endpoint URL.
 *
 * @returns {string} Normalized base URL for the `openai` SDK client.
 */
export function resolveOpenAiSdkBaseUrl(endpointUrl: string): string {
  if (endpointUrl.endsWith('/responses')) {
    return endpointUrl.slice(0, -'/responses'.length);
  }
  return endpointUrl;
}
