import type {
  OpenAiHttpRequest,
  OpenAiHttpResponse,
  OpenAiHttpTransport,
} from '../../src/index.js';

/**
 * Deterministic recorded HTTP transport fixture implementing `OpenAiHttpTransport` for unit tests.
 *
 * Captures every outbound `OpenAiHttpRequest` sent by `OpenAiModelDriver` and replays scripted
 * `OpenAiHttpResponse` payloads (including `previous_response_id`, `rs_`/`fc_`/`msg_` IDs, and
 * `encrypted_content`) in FIFO order.
 */
export class RecordedOpenAiTransport implements OpenAiHttpTransport {
  /** Ordered list of all `/v1/responses` requests captured by this transport instance. */
  readonly requests: OpenAiHttpRequest[] = [];

  /** Internal FIFO queue of scripted responses to return on subsequent `sendResponsesRequest` calls. */
  private readonly queuedResponses: OpenAiHttpResponse[];

  /**
   * Initializes a `RecordedOpenAiTransport` with an optional list of pre-queued responses.
   *
   * Copies `responses` into an internal mutable queue consumed by `sendResponsesRequest()`.
   *
   * @param {readonly OpenAiHttpResponse[]} [responses] - Scripted HTTP responses to enqueue.
   */
  constructor(responses: readonly OpenAiHttpResponse[] = []) {
    this.queuedResponses = [...responses];
  }

  /**
   * Appends a scripted `OpenAiHttpResponse` to the end of the response queue.
   *
   * Allows tests to dynamically enqueue `200` Responses API payloads or `429` rate-limit responses.
   *
   * @param {OpenAiHttpResponse} response - Scripted response to enqueue.
   *
   * @returns {void}
   */
  enqueue(response: OpenAiHttpResponse): void {
    this.queuedResponses.push(response);
  }

  /**
   * Records `request` and pops the next scripted `OpenAiHttpResponse` from the FIFO queue.
   *
   * Throws an error if `request.signal` is aborted or if the scripted queue is exhausted.
   *
   * @param {OpenAiHttpRequest} request - Outbound OpenAI `/v1/responses` request.
   *
   * @returns {Promise<OpenAiHttpResponse>} Next scripted HTTP response.
   *
   * @throws {Error} If `request.signal` is aborted or the scripted response queue is exhausted.
   */
  sendResponsesRequest(request: OpenAiHttpRequest): Promise<OpenAiHttpResponse> {
    request.signal?.throwIfAborted();
    this.requests.push(request);
    const next = this.queuedResponses.shift();
    if (next === undefined) {
      return Promise.reject(
        new Error(
          `RecordedOpenAiTransport queue exhausted on request #${String(this.requests.length)}.`,
        ),
      );
    }
    return Promise.resolve(next);
  }
}
