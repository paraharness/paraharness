import type { GeminiSdkEndpointParts } from './gemini-sdk-endpoint-parts.js';

/**
 * Splits a Gemini `generateContent` endpoint URL into `baseUrl`, `apiVersion`, and `modelId`.
 *
 * Extracts the model identifier from `/v1beta/models/{model}:generateContent` for `ai.models.generateContent()`.
 *
 * @param {string} endpointUrl - Full Gemini `generateContent` endpoint URL.
 *
 * @returns {GeminiSdkEndpointParts} Parsed SDK URL components.
 *
 * @throws {TypeError} If `endpointUrl` is not a valid URL string.
 */
export function resolveGeminiSdkEndpointParts(endpointUrl: string): GeminiSdkEndpointParts {
  const parsedUrl = new URL(endpointUrl);
  const match = /^\/(v1beta|v1alpha|v1)\/models\/([^/:]+):generateContent$/.exec(
    parsedUrl.pathname,
  );
  return Object.freeze<GeminiSdkEndpointParts>({
    baseUrl: parsedUrl.origin,
    apiVersion: match?.[1] ?? 'v1beta',
    modelId: match?.[2] ?? 'gemini-3.1-pro',
  });
}
