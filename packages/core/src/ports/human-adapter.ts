import type { HumanDecisionRequest } from './human-decision-request.js';

export type { HumanDecisionRequest } from './human-decision-request.js';

/**
 * Runtime port for outbound human notifications and bidirectional human-in-the-loop adjudications.
 *
 * Dispatched via `RuntimeExecutorRegistry.humanChannels[node.type]` to page human operators,
 * await schema-validated decisions, and cancel superseded decision requests.
 */
export interface HumanAdapter {
  /**
   * Sends a one-way notification message to the configured human channel.
   *
   * Delivers formatted alert or status text without blocking on a human response.
   *
   * @param {string} message - Formatted notification text to deliver.
   *
   * @returns {Promise<void>} Resolves once the notification has been dispatched.
   */
  notify(message: string): Promise<void>;

  /**
   * Requests a structured decision from a human operator and awaits a validated response.
   *
   * Validates the human's reply against `req.responseSchema` before resolving.
   *
   * @template TRequest  Request brief payload type.
   * @template TResponse Validated response payload type.
   *
   * @param {HumanDecisionRequest<TRequest, TResponse>} req - Decision request descriptor and response schema.
   *
   * @returns {Promise<TResponse>} Schema-validated human decision response.
   */
  requestDecision<TRequest, TResponse>(
    req: HumanDecisionRequest<TRequest, TResponse>,
  ): Promise<TResponse>;

  /**
   * Cancels an in-flight human decision request when a sibling branch or interrupt supersedes it.
   *
   * Dismisses or updates the pending prompt in the external channel for `(runId, requestId)`.
   *
   * @param {string} runId     - Identifier of the harness run owning the request.
   * @param {string} requestId - Identifier of the decision request to cancel.
   *
   * @returns {Promise<void>} Resolves once the cancellation has been processed.
   */
  cancelDecision?(runId: string, requestId: string): Promise<void>;
}
