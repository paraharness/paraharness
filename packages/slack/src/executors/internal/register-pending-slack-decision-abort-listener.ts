import type { HumanDecisionRequest } from '@paraharness/core';
import type { SlackTransport } from '../slack-transport.js';
import { cleanupPendingSlackDecision } from './cleanup-pending-slack-decision.js';
import type { PendingSlackDecisionEntry } from './pending-slack-decision-entry.js';
import type { SlackDecisionMessageTarget } from './slack-decision-message-target.js';

/**
 * Parameters for registering an `AbortSignal` listener on an in-flight Slack decision request.
 *
 * Bundles the decision request, lookup key, pending maps, Slack message coordinates, and reject callback.
 */
export interface RegisterPendingSlackDecisionAbortParams {
  /** Decision request descriptor carrying the optional `AbortSignal`. */
  readonly req: HumanDecisionRequest<unknown, unknown>;
  /** Composite lookup key `"${runId}:${requestId}"`. */
  readonly key: string;
  /** Active pending decision map indexed by composite key. */
  readonly pendingByKey: Map<string, PendingSlackDecisionEntry>;
  /** Active secondary index from `requestId` to composite key. */
  readonly pendingKeyByRequestId: Map<string, string>;
  /** Slack transport used to update the message as aborted. */
  readonly transport: SlackTransport;
  /** Target Slack message coordinates. */
  readonly target: SlackDecisionMessageTarget;
  /** Promise rejecter invoked when `req.signal` aborts. */
  readonly reject: (reason: Error) => void;
}

/**
 * Attaches an `AbortSignal` listener that cleans up pending decision state and updates the Slack message on abort.
 *
 * Returns the bound abort callback so the caller can detach it inside `finally`.
 *
 * @param {RegisterPendingSlackDecisionAbortParams} params - Abort registration parameters.
 *
 * @returns {(() => void) | undefined} Bound abort listener function, or `undefined` when `req.signal` is absent.
 */
export function registerPendingSlackDecisionAbortListener(
  params: RegisterPendingSlackDecisionAbortParams,
): (() => void) | undefined {
  const signal = params.req.signal;
  if (signal === undefined) {
    return undefined;
  }
  const onAbort = (): void => {
    params.pendingKeyByRequestId.delete(params.req.requestId);
    const removed = cleanupPendingSlackDecision(params.pendingByKey, params.key);
    if (removed !== undefined) {
      void Promise.resolve(
        params.transport.updateMessage(params.target.botToken, params.target.channel, {
          ts: removed.messageTs,
          status: 'aborted',
          text: `[ABORTED] Decision request '${params.req.requestId}' for run '${params.req.runId}' was aborted.`,
        }),
      ).catch(() => undefined);
    }
    params.reject(
      new Error(
        `Slack decision request '${params.req.requestId}' for run '${params.req.runId}' was aborted.`,
      ),
    );
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return onAbort;
}
