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
