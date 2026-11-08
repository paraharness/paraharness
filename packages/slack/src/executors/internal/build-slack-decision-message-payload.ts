import type { HumanDecisionRequest } from '@paraharness/core';

/**
 * Constructs a Slack `chat.postMessage` payload containing interactive Block Kit `actions` blocks and metadata.
 *
 * Includes `block_id: req.requestId`, interactive `Approve` and `Reject` button elements, and
 * `metadata: { requestId, runId, humanId }` for Socket Mode correlation.
 *
 * @template TRequest  Request brief payload type.
 * @template TResponse Validated response payload type.
 *
 * @param {HumanDecisionRequest<TRequest, TResponse>} req - Decision request descriptor.
 *
 * @returns {Readonly<Record<string, unknown>>} Frozen Slack message payload with Block Kit `blocks` and `metadata`.
 */
export function buildSlackDecisionMessagePayload<TRequest, TResponse>(
  req: HumanDecisionRequest<TRequest, TResponse>,
): Readonly<Record<string, unknown>> {
  const decisionText = `[Decision Request ${req.requestId}] Run '${req.runId}' awaits '${req.humanId}'.`;
  const approveValue = JSON.stringify({
    runId: req.runId,
    requestId: req.requestId,
    approved: true,
    note: 'Approved via Slack Block Kit',
  });
  const rejectValue = JSON.stringify({
    runId: req.runId,
    requestId: req.requestId,
    approved: false,
    note: 'Rejected via Slack Block Kit',
  });
  const eventPayload = Object.freeze({
    requestId: req.requestId,
    runId: req.runId,
    humanId: req.humanId,
  });
  return Object.freeze({
    kind: 'decision-request',
    runId: req.runId,
    requestId: req.requestId,
    humanId: req.humanId,
    payload: req.payload,
    text: decisionText,
    metadata: Object.freeze({
      event_type: 'harness_decision_request',
      event_payload: eventPayload,
      requestId: req.requestId,
      runId: req.runId,
      humanId: req.humanId,
    }),
    blocks: Object.freeze([
      Object.freeze({
        type: 'section',
        block_id: `${req.requestId}:section`,
        text: Object.freeze({ type: 'mrkdwn', text: decisionText }),
      }),
      Object.freeze({
        type: 'actions',
        block_id: req.requestId,
        elements: Object.freeze([
          Object.freeze({
            type: 'button',
            action_id: `${req.requestId}:approve`,
            style: 'primary',
            text: Object.freeze({ type: 'plain_text', text: 'Approve' }),
            value: approveValue,
          }),
          Object.freeze({
            type: 'button',
            action_id: `${req.requestId}:reject`,
            style: 'danger',
            text: Object.freeze({ type: 'plain_text', text: 'Reject' }),
            value: rejectValue,
          }),
        ]),
      }),
    ]),
  });
}
