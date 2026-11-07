import type { GeminiHttpRequest } from './gemini-http-request.js';
import type { GeminiHttpResponse } from './gemini-http-response.js';
import type { GeminiHttpTransport } from './gemini-http-transport.js';
import { sendGeminiGenerateContentViaSdk } from './internal/gemini-http-transport.js';

/** Base URL for the Google Gemini `/v1beta/models` HTTP API. */
export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Default `@google/genai` SDK-backed HTTP transport implementation for Google Gemini `generateContent`. */
export const defaultGeminiHttpTransport: GeminiHttpTransport = Object.freeze<GeminiHttpTransport>({
  sendGenerateContentRequest(request: GeminiHttpRequest): Promise<GeminiHttpResponse> {
    return sendGeminiGenerateContentViaSdk(request);
  },
});
