import type { HumanDecisionRequest } from '@harness-dsl/core';
import type { SlackTransport } from '../slack-transport.js';
import type { PendingSlackDecisionEntry } from './pending-slack-decision-entry.js';

/**
 * Target Slack message coordinates for periodic thread heartbeats and abort updates.
 *
 * Identifies the bot token, channel ID, and parent Slack message timestamp (`ts`).
 */
export interface SlackDecisionMessageTarget {
  /** Resolved Slack bot token (`xoxb-...`). */
  readonly botToken: string;
  /** Resolved Slack channel identifier. */
  readonly channel: string;
  /** Parent Slack message timestamp (`ts`). */
  readonly messageTs: string;
}

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
 * Computes the canonical composite lookup key for an in-flight Slack decision request.
 *
 * Combines `runId` and `requestId` for $O(1)$ lookup in `SlackApproverAdapter`'s `Map`.
 *
 * @param {string} runId     - Enclosing harness run identifier.
 * @param {string} requestId - Decision request identifier.
 *
 * @returns {string} Composite lookup key `"${runId}:${requestId}"`.
 */
export function buildSlackDecisionKey(runId: string, requestId: string): string {
  return `${runId}:${requestId}`;
}

/**
 * Stops any active keep-alive heartbeat interval and removes the entry from `pendingByKey`.
 *
 * Invoked whenever a pending Slack decision resolves, is cancelled via `cancelDecision`, or aborts.
 *
 * @param {Map<string, PendingSlackDecisionEntry>} pendingByKey - Active pending decision map.
 * @param {string}                                 key          - Composite decision key to remove.
 *
 * @returns {PendingSlackDecisionEntry | undefined} Removed entry if still pending, or `undefined`.
 */
export function cleanupPendingSlackDecision(
  pendingByKey: Map<string, PendingSlackDecisionEntry>,
  key: string,
): PendingSlackDecisionEntry | undefined {
  const entry = pendingByKey.get(key);
  if (entry === undefined) {
    return undefined;
  }
  pendingByKey.delete(key);
  if (entry.heartbeatTimer !== undefined) {
    clearInterval(entry.heartbeatTimer);
  }
  return entry;
}

/**
 * Starts a periodic thread heartbeat interval for an in-flight Slack decision request when configured.
 *
 * Returns `undefined` when `req.keepAliveSeconds` is omitted, non-positive, or `req.signal` is already aborted.
 *
 * @param {HumanDecisionRequest}       req       - Decision request descriptor.
 * @param {SlackTransport}             transport - Slack transport used to post thread heartbeats.
 * @param {SlackDecisionMessageTarget} target    - Resolved bot token, channel ID, and parent message timestamp.
 *
 * @returns {ReturnType<typeof setInterval> | undefined} Unref'd interval timer handle or `undefined`.
 */
export function startSlackDecisionHeartbeat(
  req: HumanDecisionRequest<unknown, unknown>,
  transport: SlackTransport,
  target: SlackDecisionMessageTarget,
): ReturnType<typeof setInterval> | undefined {
  if (
    req.keepAliveSeconds === undefined ||
    req.keepAliveSeconds <= 0 ||
    req.signal?.aborted === true
  ) {
    return undefined;
  }
  const timer = setInterval(() => {
    void Promise.resolve(
      transport.postMessage(target.botToken, target.channel, {
        kind: 'heartbeat',
        runId: req.runId,
        requestId: req.requestId,
        thread_ts: target.messageTs,
        text: `[Heartbeat] Still awaiting decision '${req.requestId}' for run '${req.runId}'.`,
      }),
    ).catch(() => undefined);
  }, req.keepAliveSeconds * 1000);
  timer.unref();
  return timer;
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
