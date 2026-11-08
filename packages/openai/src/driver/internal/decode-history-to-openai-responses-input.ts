import type { WireFrameRecord } from '@metaharness/core';
import { decodeFrameToOpenAiWire } from './decode-frame-to-openai-wire.js';
import type { DecodedOpenAiResponsesInput } from './decoded-openai-responses-input.js';
import { stripOpenAiServerItemIdsAndEncryptedContent } from './strip-openai-server-item-ids-and-encrypted-content.js';

/**
 * Decodes conversation `history` frames into OpenAI `/v1/responses` `inputItems` and an optional `previousResponseId`.
 *
 * Automatically strips `previous_response_id`, server item IDs (`rs_...`, `fc_...`, `msg_...`), and
 * `encrypted_content` when any history frame was recorded on a different OpenAI seat (`env.seatId !== activeSeatId`).
 *
 * @param {readonly WireFrameRecord[]} history        - Ordered conversation history frames.
 * @param {string | undefined}         [activeSeatId] - Identifier of the active OpenAI account seat.
 *
 * @returns {DecodedOpenAiResponsesInput} Frozen `inputItems` array and optional `previousResponseId`.
 */
export function decodeHistoryToOpenAiResponsesInput(
  history: readonly WireFrameRecord[],
  activeSeatId?: string,
): DecodedOpenAiResponsesInput {
  const envelopes: Readonly<Record<string, unknown>>[] = [];
  let hasCrossSeatFailover = false;
  for (const frame of history) {
    const env = decodeFrameToOpenAiWire(frame);
    envelopes.push(env);
    if (
      typeof env['seatId'] === 'string' &&
      activeSeatId !== undefined &&
      env['seatId'] !== activeSeatId
    ) {
      hasCrossSeatFailover = true;
    }
  }
  const inputItems: Readonly<Record<string, unknown>>[] = [];
  let previousResponseId: string | undefined;
  for (const env of envelopes) {
    const effective = hasCrossSeatFailover
      ? stripOpenAiServerItemIdsAndEncryptedContent(env)
      : env;
    const candidatePrev = !hasCrossSeatFailover
      ? (effective['previous_response_id'] ?? effective['responseId'])
      : undefined;
    if (typeof candidatePrev === 'string') {
      previousResponseId = candidatePrev;
    }
    const items = (
      Array.isArray(effective['items']) ? effective['items'] : []
    ) as readonly Readonly<Record<string, unknown>>[];
    for (const wireItem of items) {
      inputItems.push(wireItem);
    }
  }
  return Object.freeze<DecodedOpenAiResponsesInput>({
    inputItems: Object.freeze(inputItems),
    previousResponseId,
  });
}
