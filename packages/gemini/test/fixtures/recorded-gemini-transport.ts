import type { GeminiHttpRequest } from '../../src/driver/gemini-http-request.js';
import type { GeminiHttpResponse } from '../../src/driver/gemini-http-response.js';
import type { GeminiHttpTransport } from '../../src/driver/gemini-http-transport.js';

/**
 * Deterministic in-memory fake `GeminiHttpTransport` for unit testing `@harness-dsl/gemini`.
 *
 * Captures every outgoing `GeminiHttpRequest` in order and replays queued `GeminiHttpResponse`
 * fixtures without performing network I/O.
 */
export class RecordedGeminiTransport implements GeminiHttpTransport {
  /** Ordered list of captured outgoing HTTP requests. */
  readonly requests: GeminiHttpRequest[] = [];

  /** FIFO queue of scripted HTTP responses to return. */
  private readonly responses: GeminiHttpResponse[];

  /**
   * Initializes a new `RecordedGeminiTransport` with an optional list of scripted responses.
   *
   * Clones the provided response list into an internal mutable FIFO queue consumed by `send`.
   *
   * @param {readonly GeminiHttpResponse[]} [responses] - Initial FIFO response queue.
   */
  constructor(responses: readonly GeminiHttpResponse[] = []) {
    this.responses = [...responses];
  }

  /**
   * Records the outgoing request and pops the next scripted response from the FIFO queue.
   *
   * Rejects with an error if `request.signal` is aborted or if no scripted responses remain in the queue.
   *
   * @param {GeminiHttpRequest} request - Outgoing Gemini GenerateContent HTTP request envelope.
   *
   * @returns {Promise<GeminiHttpResponse>} Next scripted HTTP response envelope.
   */
  sendGenerateContentRequest(request: GeminiHttpRequest): Promise<GeminiHttpResponse> {
    request.signal?.throwIfAborted();
    this.requests.push(request);
    const next = this.responses.shift();
    if (next === undefined) {
      return Promise.reject(new Error('RecordedGeminiTransport has no queued responses remaining.'));
    }
    return Promise.resolve(next);
  }
}
