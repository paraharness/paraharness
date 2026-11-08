import type { HumanAdapter, HumanDecisionRequest } from '@metaharness/core';

/**
 * Deterministic `HumanAdapter` test double capturing Slack notifications, decision requests, and cancellations (`M4-integration.md` §5).
 *
 * Validates every returned human decision against `req.responseSchema` and records all outbound
 * notifications, interactive decision requests, and `cancelDecision` calls for test assertions.
 */
export class ScriptedIntegrationHumanAdapter implements HumanAdapter {
  /** Ordered list of outbound notification strings delivered via `notify(message)`. */
  readonly notifications: string[] = [];

  /** Ordered list of interactive decision request summaries received via `requestDecision(req)`. */
  readonly decisionRequests: Array<{
    readonly runId: string;
    readonly requestId: string;
    readonly humanId: string;
    readonly payload: unknown;
  }> = [];

  /** Ordered list of `(runId, requestId)` pairs cancelled via `cancelDecision(runId, requestId)`. */
  readonly cancelledDecisions: Array<{
    readonly runId: string;
    readonly requestId: string;
  }> = [];

  /** Callback invoked to produce a decision response for each `requestDecision` call. */
  private readonly decisionResponder: (
    req: {
      readonly runId: string;
      readonly requestId: string;
      readonly humanId: string;
      readonly payload: unknown;
    },
    index: number,
  ) => unknown | Promise<unknown>;

  /**
   * Initializes a `ScriptedIntegrationHumanAdapter` with a deterministic decision responder callback.
   *
   * Invokes `decisionResponder(req, index)` whenever an actor or interrupt edge pages the human authority.
   *
   * @param {(req: { readonly runId: string; readonly requestId: string; readonly humanId: string; readonly payload: unknown }, index: number) => unknown | Promise<unknown>} decisionResponder - Callback returning the unvalidated or validated decision object.
   */
  constructor(
    decisionResponder: (
      req: {
        readonly runId: string;
        readonly requestId: string;
        readonly humanId: string;
        readonly payload: unknown;
      },
      index: number,
    ) => unknown | Promise<unknown>,
  ) {
    this.decisionResponder = decisionResponder;
  }

  /**
   * Records a one-way notification message delivered to this human channel.
   *
   * Appends `message` to `this.notifications` and resolves immediately.
   *
   * @param {string} message - Formatted notification string.
   *
   * @returns {Promise<void>} Resolves once `message` is recorded.
   */
  notify(message: string): Promise<void> {
    this.notifications.push(message);
    return Promise.resolve();
  }

  /**
   * Records an interactive human decision request and returns the schema-validated scripted response.
   *
   * Invokes `this.decisionResponder(recordedReq, index)` and parses the result with `req.responseSchema`.
   *
   * @template TRequest  Request brief payload type.
   * @template TResponse Validated decision response type.
   *
   * @param {HumanDecisionRequest<TRequest, TResponse>} req - Decision request descriptor and response schema.
   *
   * @returns {Promise<TResponse>} Schema-validated decision response.
   */
  async requestDecision<TRequest, TResponse>(
    req: HumanDecisionRequest<TRequest, TResponse>,
  ): Promise<TResponse> {
    const index = this.decisionRequests.length;
    const recordedReq = Object.freeze({
      runId: req.runId,
      requestId: req.requestId,
      humanId: req.humanId,
      payload: req.payload,
    });
    this.decisionRequests.push(recordedReq);
    const rawDecision = await this.decisionResponder(recordedReq, index);
    return req.responseSchema.parse(rawDecision);
  }

  /**
   * Records cancellation of a superseded or timed-out human decision request.
   *
   * Appends `{ runId, requestId }` to `this.cancelledDecisions`.
   *
   * @param {string} runId     - Run identifier owning the cancelled request.
   * @param {string} requestId - Decision request identifier to cancel.
   *
   * @returns {Promise<void>} Resolves once the cancellation is recorded.
   */
  cancelDecision(runId: string, requestId: string): Promise<void> {
    this.cancelledDecisions.push(Object.freeze({ runId, requestId }));
    return Promise.resolve();
  }
}
