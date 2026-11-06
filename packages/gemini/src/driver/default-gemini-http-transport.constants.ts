import type { GeminiHttpRequest } from './gemini-http-request.js';
import type { GeminiHttpResponse } from './gemini-http-response.js';
import type { GeminiHttpTransport } from './gemini-http-transport.js';

/** Base URL for the Google Gemini `/v1beta/models` HTTP API. */
export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Default `fetch`-backed HTTP transport implementation for Google Gemini `generateContent`. */
export const defaultGeminiHttpTransport: GeminiHttpTransport = Object.freeze<GeminiHttpTransport>({
  async sendGenerateContentRequest(request: GeminiHttpRequest): Promise<GeminiHttpResponse> {
    request.signal?.throwIfAborted();
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: request.signal,
    });
    const rawText = await response.text();
    const parsedBody =
      rawText.trim().length > 0
        ? (JSON.parse(rawText) as Readonly<Record<string, unknown>>)
        : Object.freeze({});
    const retryAfterHeader = response.headers.get('retry-after');
    const resetAtMs =
      retryAfterHeader !== null && !Number.isNaN(Number(retryAfterHeader))
        ? Date.now() + Number(retryAfterHeader) * 1_000
        : undefined;
    return Object.freeze<GeminiHttpResponse>({
      status: response.status,
      body: parsedBody,
      resetAtMs,
    });
  },
});
