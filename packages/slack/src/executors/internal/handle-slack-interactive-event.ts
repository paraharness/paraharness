/**
 * Safely narrows an unknown value to a readonly key-value record.
 *
 * Returns an empty object when `candidate` is not a non-null object.
 *
 * @param {unknown} candidate - Value to narrow to a record.
 *
 * @returns {Readonly<Record<string, unknown>>} Narrowed record or empty object.
 */
function asRecord(candidate: unknown): Readonly<Record<string, unknown>> {
  return typeof candidate === 'object' && candidate !== null
    ? (candidate as Readonly<Record<string, unknown>>)
    : {};
}

/**
 * Resolves the first non-empty string among candidate values.
 *
 * Used to resolve `runId` and `requestId` across action values, message metadata, and block IDs.
 *
 * @param {readonly unknown[]} candidates - Ordered candidate values to inspect.
 *
 * @returns {string} First non-empty string candidate, or `''` if none match.
 */
function firstNonEmptyString(candidates: readonly unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return '';
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
function parseSlackActionValue(rawValue: string): unknown {
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
 * Extracts `(runId, requestId, responsePayload)` from a Slack interactive event `body`.
 *
 * Reads `runId` and `requestId` from `actions[0].value`, falling back to `body.message.metadata`,
 * `body.message.metadata.event_payload`, and `actions[0].block_id`.
 *
 * @param {Readonly<Record<string, unknown>>} body - Slack Socket Mode interactive event `body`.
 *
 * @returns {{ readonly runId: string; readonly requestId: string; readonly responsePayload: unknown }} Extracted routing identifiers and parsed response payload.
 */
function extractSlackInteractiveAction(body: Readonly<Record<string, unknown>>): {
  readonly runId: string;
  readonly requestId: string;
  readonly responsePayload: unknown;
} {
  const actions = Array.isArray(body['actions']) ? body['actions'] : [];
  const firstAction = asRecord(actions[0]);
  const rawValue = typeof firstAction['value'] === 'string' ? firstAction['value'] : '';
  const responsePayload = parseSlackActionValue(rawValue);
  const parsedObj = asRecord(responsePayload);
  const metadata = asRecord(asRecord(body['message'])['metadata']);
  const eventPayload = asRecord(metadata['event_payload']);
  const runId = firstNonEmptyString([
    parsedObj['runId'],
    metadata['runId'],
    eventPayload['runId'],
  ]);
  const requestId = firstNonEmptyString([
    parsedObj['requestId'],
    metadata['requestId'],
    eventPayload['requestId'],
    firstAction['block_id'],
  ]);
  return { runId, requestId, responsePayload };
}

/**
 * Acknowledges an inbound Slack Socket Mode interactive event and routes the action payload to `onInteractiveAction`.
 *
 * Extracts `requestId` and `runId` from `body.actions[0]` or `body.message.metadata` via
 * `extractSlackInteractiveAction` and forwards the parsed action payload when `requestId` is non-empty.
 *
 * @param {unknown}                                                                event                 - Raw Socket Mode `'interactive'` event envelope.
 * @param {(runId: string, requestId: string, responsePayload: unknown) => void} [onInteractiveAction] - Optional callback receiving `(runId, requestId, responsePayload)`.
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
  const action = extractSlackInteractiveAction(asRecord(envelope['body']));
  if (action.requestId.length > 0) {
    onInteractiveAction(action.runId, action.requestId, action.responsePayload);
  }
}
