import type { GeminiHttpRequest } from './gemini-http-request.js';
import type { GeminiHttpResponse } from './gemini-http-response.js';

/**
 * Injectable HTTP transport port for dispatching Google Gemini `generateContent` requests.
 *
 * Allows `GeminiModelDriver` to execute against either the production `fetch` transport
 * or deterministic recorded transport fixtures in unit and integration tests.
 */
export interface GeminiHttpTransport {
  /**
   * Sends a single `/v1beta/models/{model}:generateContent` POST request and returns the parsed response.
   *
   * Implementations must honor `request.signal` and return status `429` with `resetAtMs` rather
   * than swallowing rate-limit responses so `PoolManager` can fail over across seats.
   *
   * @param {GeminiHttpRequest} request - Wire-formatted Gemini `generateContent` request.
   *
   * @returns {Promise<GeminiHttpResponse>} HTTP status code, response body, and optional rate-limit reset timestamp.
   */
  sendGenerateContentRequest(request: GeminiHttpRequest): Promise<GeminiHttpResponse>;
}
