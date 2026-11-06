import type { EnvRef, HumanDecisionRequest } from '@harness-dsl/core';
import type { SlackTransport } from '../slack-transport.js';
import type { PendingSlackDecisionEntry } from './pending-slack-decision-entry.js';

/**
 * Resolves a required Slack credential or channel identifier from a literal string or symbolic `EnvRef`.
 *
 * Throws an actionable error if the referenced environment variable is unset or empty.
 *
 * @param {string | EnvRef}                              value      - Literal value or symbolic `EnvRef`.
 * @param {(val: string | EnvRef) => string | undefined} resolveEnv - Runtime environment resolver callback.
 * @param {string}                                       fieldLabel - Diagnostic field name (`'appToken'`, `'botToken'`, `'channel'`, `'webhookUrl'`).
 *
 * @returns {string} Non-empty resolved string value.
 */
export function resolveRequiredSlackSecret(
  value: string | EnvRef,
  resolveEnv: (val: string | EnvRef) => string | undefined,
  fieldLabel: string,
): string {
  const resolved = resolveEnv(value);
  if (resolved === undefined || resolved.length === 0) {
    const keyDesc = typeof value === 'string' ? '<literal>' : value.key;
    throw new Error(`Missing required Slack ${fieldLabel} ('${keyDesc}').`);
  }
  return resolved;
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
 * Returns `undefined` when `req.keepAliveSeconds` is omitted or non-positive.
 *
 * @param {HumanDecisionRequest} req       - Decision request descriptor.
 * @param {SlackTransport}       transport - Slack transport used to post thread heartbeats.
 * @param {object}               target    - Resolved bot token, channel ID, and parent message timestamp.
 *
 * @returns {ReturnType<typeof setInterval> | undefined} Unref'd interval timer handle or `undefined`.
 */
export function startSlackDecisionHeartbeat(
  req: HumanDecisionRequest<unknown, unknown>,
  transport: SlackTransport,
  target: {
    readonly botToken: string;
    readonly channel: string;
    readonly messageTs: string;
  },
): ReturnType<typeof setInterval> | undefined {
  if (req.keepAliveSeconds === undefined || req.keepAliveSeconds <= 0) {
    return undefined;
  }
  const timer = setInterval(() => {
    void transport.postMessage(target.botToken, target.channel, {
      kind: 'heartbeat',
      runId: req.runId,
      requestId: req.requestId,
      thread_ts: target.messageTs,
      text: `[Heartbeat] Still awaiting decision '${req.requestId}' for run '${req.runId}'.`,
    });
  }, req.keepAliveSeconds * 1000);
  timer.unref();
  return timer;
}
