import type { GeminiSdkFetchCapture } from './gemini-sdk-fetch-capture.js';

/**
 * Parameters for creating a Gemini SDK `fetch` wrapper via `createGeminiSdkFetch()`.
 *
 * Supplies the explicit API key flag, serialized wire body, underlying `fetch` function, and capture sink.
 */
export interface CreateGeminiSdkFetchParams {
  /** Whether the seat provided an explicit `x-goog-api-key` header. */
  readonly hasExplicitApiKey: boolean;
  /** Exact wire JSON request body to transmit to `generateContent`. */
  readonly requestBody: Readonly<Record<string, unknown>>;
  /** Underlying `fetch` implementation to invoke. */
  readonly baseFetch: typeof globalThis.fetch;
  /** Response metadata sink updated with the observed status code and `retry-after` header. */
  readonly capture: GeminiSdkFetchCapture;
}

/**
 * Wraps the target `fetch` function used by `@google/genai` to transmit the exact wire body and capture HTTP status metadata.
 *
 * Strips placeholder `x-goog-api-key` headers when `params.hasExplicitApiKey` is `false` and records
 * `status` and `retry-after` on `params.capture`.
 *
 * @param {CreateGeminiSdkFetchParams} params - Explicit key flag, wire body, base `fetch`, and capture sink.
 *
 * @returns {typeof globalThis.fetch} Wrapped `fetch` function passed to `GoogleGenAI` `httpOptions.fetch`.
 */
export function createGeminiSdkFetch(
  params: CreateGeminiSdkFetchParams,
): typeof globalThis.fetch {
  const { hasExplicitApiKey, requestBody, baseFetch, capture } = params;
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const mergedHeaders = new Headers(init?.headers);
    if (!hasExplicitApiKey) {
      mergedHeaders.delete('x-goog-api-key');
    }
    const rawResponse = await baseFetch(input, {
      ...init,
      headers: mergedHeaders,
      body: JSON.stringify(requestBody),
    });
    capture.status = rawResponse.status;
    capture.retryAfter = rawResponse.headers.get('retry-after');
    return rawResponse;
  };
}
