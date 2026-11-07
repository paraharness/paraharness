import type { HumanDecisionRequest } from '@harness-dsl/core';
import type { SlackTransport } from '../slack-transport.js';
import type { SlackDecisionMessageTarget } from './slack-decision-message-target.js';

/**
 * Starts a periodic thread heartbeat interval for an in-flight Slack decision request when configured.
 *
 * Returns `undefined` when `req.keepAliveSeconds` is omitted, non-positive, or `req.signal` is already aborted.
 *
 * @param {HumanDecisionRequest<unknown, unknown>} req       - Decision request descriptor.
 * @param {SlackTransport}                         transport - Slack transport used to post thread heartbeats.
 * @param {SlackDecisionMessageTarget}             target    - Resolved bot token, channel ID, and parent message timestamp.
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
