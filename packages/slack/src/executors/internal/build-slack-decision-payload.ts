import type { HarnessRuntimeController, HumanDecisionRequest } from '@harness-dsl/core';

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
  const approveValue = JSON.stringify({ runId: req.runId, requestId: req.requestId, approved: true, note: 'Approved via Slack Block Kit' });
  const rejectValue = JSON.stringify({ runId: req.runId, requestId: req.requestId, approved: false, note: 'Rejected via Slack Block Kit' });
  const eventPayload = Object.freeze({ requestId: req.requestId, runId: req.runId, humanId: req.humanId });
  return Object.freeze({
    kind: 'decision-request', runId: req.runId, requestId: req.requestId, humanId: req.humanId,
    payload: req.payload, text: decisionText,
    metadata: Object.freeze({
      event_type: 'harness_decision_request', event_payload: eventPayload,
      requestId: req.requestId, runId: req.runId, humanId: req.humanId,
    }),
    blocks: Object.freeze([
      Object.freeze({
        type: 'section', block_id: `${req.requestId}:section`,
        text: Object.freeze({ type: 'mrkdwn', text: decisionText }),
      }),
      Object.freeze({
        type: 'actions', block_id: req.requestId,
        elements: Object.freeze([
          Object.freeze({
            type: 'button', action_id: `${req.requestId}:approve`, style: 'primary',
            text: Object.freeze({ type: 'plain_text', text: 'Approve' }), value: approveValue,
          }),
          Object.freeze({
            type: 'button', action_id: `${req.requestId}:reject`, style: 'danger',
            text: Object.freeze({ type: 'plain_text', text: 'Reject' }), value: rejectValue,
          }),
        ]),
      }),
    ]),
  });
}

/**
 * Parses a Slack Block Kit button action `value` string as JSON, falling back to `{ value: rawValue }`.
 *
 * Returns `rawValue` unchanged when empty so callers can inspect object properties safely.
 *
 * @param {string} rawValue - Raw string value from a Slack interactive button element.
 *
 * @returns {unknown} Parsed JSON value or `{ value: rawValue }` fallback.
 */
export function parseSlackActionValue(rawValue: string): unknown {
  if (rawValue.length === 0) {
    return '';
  }
  try {
    return JSON.parse(rawValue);
  } catch {
    return { value: rawValue };
  }
}

/**
 * Acknowledges an inbound Slack Socket Mode interactive event and routes the action payload to `onInteractiveAction`.
 *
 * Extracts `requestId` and `runId` from `body.actions[0]` or `body.message.metadata` and parses the JSON button `value`.
 *
 * @param {unknown}  event                 - Raw Socket Mode `'interactive'` event envelope.
 * @param {Function} [onInteractiveAction] - Optional callback receiving `(runId, requestId, responsePayload)`.
 *
 * @returns {Promise<void>} Resolves once `ack()` and `onInteractiveAction` complete.
 */
export async function handleSlackInteractiveEvent(
  event: unknown,
  onInteractiveAction?: (runId: string, requestId: string, responsePayload: unknown) => void,
): Promise<void> {
  if (typeof event !== 'object' || event === null) {
    return;
  }
  const envelope = event as Readonly<Record<string, unknown>>;
  if (typeof envelope['ack'] === 'function') {
    await (envelope['ack'] as () => Promise<void>)();
  }
  if (onInteractiveAction === undefined) {
    return;
  }
  const body = typeof envelope['body'] === 'object' && envelope['body'] !== null ? (envelope['body'] as Readonly<Record<string, unknown>>) : {};
  const actions = Array.isArray(body['actions']) ? body['actions'] : [];
  const firstAction = typeof actions[0] === 'object' && actions[0] !== null ? (actions[0] as Readonly<Record<string, unknown>>) : {};
  const blockId = typeof firstAction['block_id'] === 'string' ? firstAction['block_id'] : '';
  const rawValue = typeof firstAction['value'] === 'string' ? firstAction['value'] : '';
  const parsedValue = parseSlackActionValue(rawValue);
  const parsedObj = typeof parsedValue === 'object' && parsedValue !== null ? (parsedValue as Readonly<Record<string, unknown>>) : {};
  const runId = typeof parsedObj['runId'] === 'string' ? parsedObj['runId'] : '';
  const requestId = typeof parsedObj['requestId'] === 'string' ? parsedObj['requestId'] : blockId;
  if (requestId.length > 0) {
    onInteractiveAction(runId, requestId, parsedValue);
  }
}

/**
 * Acknowledges an inbound Slack Socket Mode slash command and forwards JSON signal payloads to `controller.emitSignal`.
 *
 * Parses `{ signalId, payload }` from `command.text` when present and invokes `controller.emitSignal`.
 *
 * @param {unknown}                  event      - Raw Socket Mode `'slash_commands'` event envelope.
 * @param {HarnessRuntimeController} controller - Active runtime controller.
 *
 * @returns {Promise<void>} Resolves once `ack()` and signal emission complete.
 */
export async function handleSlackSlashCommandEvent(
  event: unknown,
  controller: HarnessRuntimeController,
): Promise<void> {
  if (typeof event !== 'object' || event === null) {
    return;
  }
  const envelope = event as Readonly<Record<string, unknown>>;
  if (typeof envelope['ack'] === 'function') {
    await (envelope['ack'] as () => Promise<void>)();
  }
  const body = typeof envelope['body'] === 'object' && envelope['body'] !== null ? (envelope['body'] as Readonly<Record<string, unknown>>) : {};
  const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Readonly<Record<string, unknown>>;
      if (typeof parsed['signalId'] === 'string') {
        await controller.emitSignal(parsed['signalId'], parsed['payload']);
      }
    } catch {
      return;
    }
  }
}
