import type { OpenAiHttpRequest } from './openai-http-request.js';
import type { OpenAiHttpResponse } from './openai-http-response.js';

/**
 * Injectable HTTP transport port for dispatching OpenAI `/v1/responses` requests.
 *
 * Allows `OpenAiModelDriver` to execute against either the production `fetch` transport
 * or deterministic recorded transport fixtures in unit and integration tests.
 */
export interface OpenAiHttpTransport {
  /**
   * Sends a single `/v1/responses` POST request to the OpenAI Responses API and returns the parsed response.
   *
   * Implementations must honor `request.signal` and return status `429` with `resetAtMs` rather
   * than swallowing rate-limit responses so `PoolManager` can fail over across seats.
   *
   * @param {OpenAiHttpRequest} request - Wire-formatted OpenAI Responses API request.
   *
   * @returns {Promise<OpenAiHttpResponse>} HTTP status code, response body, and optional rate-limit reset timestamp.
   */
  sendResponsesRequest(request: OpenAiHttpRequest): Promise<OpenAiHttpResponse>;
}
