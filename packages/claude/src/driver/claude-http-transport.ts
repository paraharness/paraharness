import type { ClaudeHttpRequest } from './claude-http-request.js';
import type { ClaudeHttpResponse } from './claude-http-response.js';

/**
 * Injectable HTTP transport port for dispatching Anthropic `/v1/messages` requests.
 *
 * Allows `ClaudeModelDriver` to execute against either the production `fetch` transport
 * or deterministic recorded transport fixtures in unit and integration tests.
 */
export interface ClaudeHttpTransport {
  /**
   * Sends a single `/v1/messages` POST request to the Anthropic API and returns the parsed response.
   *
   * Implementations must honor `request.signal` and return status `429` with `resetAtMs` rather
   * than swallowing rate-limit responses so `PoolManager` can fail over across seats.
   *
   * @param {ClaudeHttpRequest} request - Wire-formatted Anthropic Messages API request.
   *
   * @returns {Promise<ClaudeHttpResponse>} HTTP status code, response body, and optional rate-limit reset timestamp.
   *
   * @throws {Error} If `request.signal` is aborted or an unrecoverable transport failure occurs.
   */
  sendMessagesRequest(request: ClaudeHttpRequest): Promise<ClaudeHttpResponse>;
}
