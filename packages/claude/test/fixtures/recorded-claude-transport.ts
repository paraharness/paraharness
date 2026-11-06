import type {
  ClaudeHttpRequest,
  ClaudeHttpResponse,
  ClaudeHttpTransport,
} from '../../src/index.js';

/**
 * Deterministic recorded HTTP transport fixture implementing `ClaudeHttpTransport` for unit tests.
 *
 * Captures every outbound `ClaudeHttpRequest` sent by `ClaudeModelDriver` and replays scripted
 * `ClaudeHttpResponse` frames (including extended `thinking` + `signature` blocks and HTTP `429` responses)
 * in FIFO order.
 */
export class RecordedClaudeTransport implements ClaudeHttpTransport {
  /** Ordered list of all `/v1/messages` requests captured by this transport instance. */
  readonly requests: ClaudeHttpRequest[] = [];

  /** Internal FIFO queue of scripted responses to return on subsequent `sendMessagesRequest` calls. */
  private readonly queuedResponses: ClaudeHttpResponse[];

  /**
   * Initializes a `RecordedClaudeTransport` with an optional list of pre-queued responses.
   *
   * Copies `responses` into an internal mutable queue consumed by `sendMessagesRequest()`.
   *
   * @param {readonly ClaudeHttpResponse[]} [responses] - Scripted HTTP responses to enqueue.
   */
  constructor(responses: readonly ClaudeHttpResponse[] = []) {
    this.queuedResponses = [...responses];
  }

  /**
   * Appends a scripted `ClaudeHttpResponse` to the end of the response queue.
   *
   * Allows tests to dynamically enqueue `200` message responses or `429` rate-limit responses between turns.
   *
   * @param {ClaudeHttpResponse} response - Scripted response to enqueue.
   *
   * @returns {void}
   */
  enqueue(response: ClaudeHttpResponse): void {
    this.queuedResponses.push(response);
  }

  /**
   * Records `request` and pops the next scripted `ClaudeHttpResponse` from the FIFO queue.
   *
   * Throws an error if `request.signal` is aborted or if the scripted queue is exhausted.
   *
   * @param {ClaudeHttpRequest} request - Outbound Anthropic `/v1/messages` request.
   *
   * @returns {Promise<ClaudeHttpResponse>} Next scripted HTTP response.
   */
  sendMessagesRequest(request: ClaudeHttpRequest): Promise<ClaudeHttpResponse> {
    request.signal?.throwIfAborted();
    this.requests.push(request);
    const next = this.queuedResponses.shift();
    if (next === undefined) {
      return Promise.reject(
        new Error(
          `RecordedClaudeTransport queue exhausted on request #${String(this.requests.length)}.`,
        ),
      );
    }
    return Promise.resolve(next);
  }
}
