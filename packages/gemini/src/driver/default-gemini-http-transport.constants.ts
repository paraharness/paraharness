import type { GeminiHttpRequest } from './gemini-http-request.js';
import type { GeminiHttpResponse } from './gemini-http-response.js';
import type { GeminiHttpTransport } from './gemini-http-transport.js';
import { sendGeminiGenerateContentViaSdk } from './internal/send-gemini-generate-content-via-sdk.js';

/** Base URL for the Google Gemini `/v1beta/models` HTTP API. */
export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Default `@google/genai` SDK-backed HTTP transport implementation for Google Gemini `generateContent`. */
export const defaultGeminiHttpTransport: GeminiHttpTransport = Object.freeze<GeminiHttpTransport>({
  /**
   * Dispatches a `/v1beta/models/{model}:generateContent` POST request via the official `@google/genai` SDK.
   *
   * Forwards `request` directly to `sendGeminiGenerateContentViaSdk()`.
   *
   * @param {GeminiHttpRequest} request - Wire-formatted Gemini `generateContent` request.
   *
   * @returns {Promise<GeminiHttpResponse>} HTTP status, parsed body, and optional `resetAtMs`.
   *
   * @throws {Error} If `request.signal` is aborted or a network transport exception occurs.
   */
  sendGenerateContentRequest(request: GeminiHttpRequest): Promise<GeminiHttpResponse> {
    return sendGeminiGenerateContentViaSdk(request);
  },
});
