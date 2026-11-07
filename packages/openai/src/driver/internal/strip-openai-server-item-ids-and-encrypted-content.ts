import { OPENAI_SERVER_ITEM_ID_PATTERN } from '../default-openai-http-transport.constants.js';

/**
 * Sanitizes a single OpenAI wire item by removing `encrypted_content` and account-bound server `id` fields.
 *
 * Uses object destructuring rather than `Object.entries()` in hot loops per `Rule 4.2`.
 *
 * @param {Readonly<Record<string, unknown>>} wireItem - Raw OpenAI input or output item.
 *
 * @returns {Readonly<Record<string, unknown>>} Frozen sanitized wire item.
 */
function sanitizeSingleOpenAiWireItem(
  wireItem: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { id: candidateId, encrypted_content: _encryptedContent, ...restFields } = wireItem;
  void _encryptedContent;
  const shouldKeepId =
    candidateId !== undefined &&
    !(typeof candidateId === 'string' && OPENAI_SERVER_ITEM_ID_PATTERN.test(candidateId));
  if (shouldKeepId) {
    return Object.freeze({ id: candidateId, ...restFields });
  }
  return Object.freeze({ ...restFields });
}

/**
 * Strips account-bound `previous_response_id`, server item IDs (`rs_...`, `fc_...`, `msg_...`), and `encrypted_content`.
 *
 * Preserves reasoning `summary` text and canonical message/tool items so transcripts replay cleanly
 * across distinct models (`substituteTombstones: true`) or across distinct OpenAI seats (`Seat A` to `Seat B`).
 *
 * @param {Readonly<Record<string, unknown>>} wireEnvelope - Decoded OpenAI wire envelope.
 *
 * @returns {Readonly<Record<string, unknown>>} Sanitized OpenAI wire envelope with account-bound state removed.
 */
export function stripOpenAiServerItemIdsAndEncryptedContent(
  wireEnvelope: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const rawItems = Array.isArray(wireEnvelope['items'])
    ? (wireEnvelope['items'] as readonly Readonly<Record<string, unknown>>[])
    : [];
  const sanitizedItems: Readonly<Record<string, unknown>>[] = [];
  for (const wireItem of rawItems) {
    sanitizedItems.push(sanitizeSingleOpenAiWireItem(wireItem));
  }
  return Object.freeze({ items: Object.freeze(sanitizedItems) });
}
