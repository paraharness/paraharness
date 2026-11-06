import type { HumanAdapter } from '../../src/ports/human-adapter.js';
import type { HumanDecisionRequest } from '../../src/ports/human-decision-request.js';

/**
 * Deterministic `HumanAdapter` test fixture supporting scripted decision responses, barrier latches, `notify` logs, and `cancelDecision` tracking (`SPEC.md` §3.6 & §3.10).
 *
 * Used to test `.ask()`, `.maxCostUsd()`, `.onSignal().notify()`, `.speculate()` unpark rulings, and sibling interrupt cancellation.
 */
export class ScriptedHumanAdapter implements HumanAdapter {
  /** Recorded one-way `notify(message)` strings in chronological order. */
  readonly notifications: string[] = [];
  /** Recorded `requestDecision` payloads in chronological order. */
  readonly decisionRequests: Array<HumanDecisionRequest<unknown, unknown>> = [];
  /** Recorded `cancelDecision(runId, requestId)` calls in chronological order. */
  readonly cancelledRequests: Array<{ readonly runId: string; readonly requestId: string }> = [];
  /** Queue of scripted decision responses or async handlers. */
  private readonly decisionQueue: Array<unknown | ((req: HumanDecisionRequest<unknown, unknown>) => unknown | Promise<unknown>)>;

  /**
   * Creates a `ScriptedHumanAdapter` with an optional queue of scripted decision responses.
   *
   * Pops one entry from `decisions` on each `requestDecision` call.
   *
   * @param {ReadonlyArray<unknown | ((req: HumanDecisionRequest<unknown, unknown>) => unknown | Promise<unknown>)>} [decisions] - Scripted human decisions.
   */
  constructor(
    decisions: ReadonlyArray<unknown | ((req: HumanDecisionRequest<unknown, unknown>) => unknown | Promise<unknown>)> = [],
  ) {
    this.decisionQueue = [...decisions];
  }

  /**
   * Enqueues an additional scripted decision response or callback.
   *
   * Appends `decision` to `decisionQueue`.
   *
   * @param {unknown | ((req: HumanDecisionRequest<unknown, unknown>) => unknown | Promise<unknown>)} decision - Response or callback to enqueue.
   */
  enqueueDecision(decision: unknown | ((req: HumanDecisionRequest<unknown, unknown>) => unknown | Promise<unknown>)): void {
    this.decisionQueue.push(decision);
  }

  /**
   * Records a one-way notification message in `notifications`.
   *
   * Satisfies `HumanAdapter.notify`.
   *
   * @param {string} message - Formatted notification text.
   *
   * @returns {Promise<void>} Resolves once recorded.
   */
  async notify(message: string): Promise<void> {
    this.notifications.push(message);
  }

  /**
   * Records `req` in `decisionRequests` and resolves the next scripted response validated against `req.responseSchema`.
   *
   * Throws if `decisionQueue` is empty.
   *
   * @template TRequest  Request brief payload type.
   * @template TResponse Validated response payload type.
   *
   * @param {HumanDecisionRequest<TRequest, TResponse>} req - Decision request descriptor.
   *
   * @returns {Promise<TResponse>} Validated human decision response.
   */
  async requestDecision<TRequest, TResponse>(req: HumanDecisionRequest<TRequest, TResponse>): Promise<TResponse> {
    this.decisionRequests.push(req as HumanDecisionRequest<unknown, unknown>);
    const next = this.decisionQueue.shift();
    if (next === undefined) {
      throw new Error(`ScriptedHumanAdapter decisionQueue exhausted for human '${req.humanId}' (requestId '${req.requestId}').`);
    }
    const raw = typeof next === 'function'
      ? await (next as (r: HumanDecisionRequest<unknown, unknown>) => unknown | Promise<unknown>)(req as HumanDecisionRequest<unknown, unknown>)
      : next;
    return req.responseSchema.parse(raw);
  }

  /**
   * Records a cancelled decision request `(runId, requestId)` in `cancelledRequests`.
   *
   * Invoked during sibling fork interrupt barriers and flow rewind drain barriers.
   *
   * @param {string} runId     - Enclosing flow run identifier.
   * @param {string} requestId - Cancelled decision request identifier.
   *
   * @returns {Promise<void>} Resolves once recorded.
   */
  async cancelDecision(runId: string, requestId: string): Promise<void> {
    this.cancelledRequests.push(Object.freeze({ runId, requestId }));
  }
}
