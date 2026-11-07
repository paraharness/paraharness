import type { PendingSlackDecisionEntry } from './pending-slack-decision-entry.js';

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
