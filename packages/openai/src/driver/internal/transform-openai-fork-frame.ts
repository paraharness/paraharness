import type {
  CanonicalMessage,
  CanonicalToolResult,
  OpenAiAccountSeatNode,
  PrepareForkTarget,
  WireFrameRecord,
} from '@harness-dsl/core';
import { decodeFrameToOpenAiWire } from './decode-frame-to-openai-wire.js';
import { projectCanonicalToOpenAiWire } from './project-canonical-to-openai-wire.js';
import { stripOpenAiServerItemIdsAndEncryptedContent } from './strip-openai-server-item-ids-and-encrypted-content.js';

/**
 * Parameters for transforming a single parent `WireFrameRecord` via `transformOpenAiForkFrame()`.
 *
 * Supplies the parent frame, target model/seat configuration, and fork-point indicator.
 */
export interface TransformOpenAiForkFrameParams {
  /** Source parent wire frame record to clone or sanitize. */
  readonly frame: WireFrameRecord;
  /** Target model configuration and `substituteTombstones` flag. */
  readonly target: PrepareForkTarget;
  /** Whether `frame` is the terminal fork-point message in the sliced parent chain. */
  readonly isForkPoint: boolean;
}

/**
 * Transforms a single parent `WireFrameRecord` during OpenAI `'clone-transcript'` fork preparation.
 *
 * Preserves `previous_response_id`, server item IDs (`rs_...`, `fc_...`, `msg_...`), and `encrypted_content`
 * on same-model, same-seat forks (`substituteTombstones === false`), and strips them while substituting
 * `compactedTombstones` when `substituteTombstones === true` or on cross-seat failover.
 *
 * @param {TransformOpenAiForkFrameParams} params - Source frame, target configuration, and fork-point flag.
 *
 * @returns {WireFrameRecord} Cloned or sanitized OpenAI wire frame record.
 */
export function transformOpenAiForkFrame(params: TransformOpenAiForkFrameParams): WireFrameRecord {
  const { frame, target, isForkPoint } = params;
  const envelope = decodeFrameToOpenAiWire(frame);
  const targetSeat = target.accountConfig as OpenAiAccountSeatNode | undefined;
  const isCrossSeat =
    typeof envelope['seatId'] === 'string' &&
    targetSeat?.id !== undefined &&
    envelope['seatId'] !== targetSeat.id;
  if (!target.substituteTombstones && !isCrossSeat) {
    if (isForkPoint && typeof envelope['responseId'] === 'string') {
      const branched = Object.freeze({
        ...envelope,
        previous_response_id: envelope['responseId'],
      });
      return Object.freeze<WireFrameRecord>({
        messageId: frame.messageId,
        parentMessageId: frame.parentMessageId,
        vendorId: 'openai',
        rawWireFrame: new TextEncoder().encode(JSON.stringify(branched)),
        canonical: frame.canonical,
        prefixDigest: frame.prefixDigest,
        compactedTombstones: frame.compactedTombstones,
      });
    }
    return frame;
  }
  const tombstones = target.substituteTombstones ? (frame.compactedTombstones ?? {}) : {};
  const updatedResults: CanonicalToolResult[] = [];
  for (const toolResult of frame.canonical.toolResults ?? []) {
    updatedResults.push(
      Object.freeze<CanonicalToolResult>({
        callId: toolResult.callId,
        content: tombstones[toolResult.callId] ?? toolResult.content,
        isError: toolResult.isError,
      }),
    );
  }
  const canonical = Object.freeze<CanonicalMessage>({
    role: frame.canonical.role,
    visibleText: frame.canonical.visibleText,
    toolCalls: frame.canonical.toolCalls,
    toolResults:
      frame.canonical.toolResults !== undefined ? Object.freeze(updatedResults) : undefined,
  });
  const baseEnvelope =
    frame.canonical.role === 'tool'
      ? projectCanonicalToOpenAiWire(canonical)
      : stripOpenAiServerItemIdsAndEncryptedContent(envelope);
  return Object.freeze<WireFrameRecord>({
    messageId: frame.messageId,
    parentMessageId: frame.parentMessageId,
    vendorId: 'openai',
    rawWireFrame: new TextEncoder().encode(JSON.stringify(baseEnvelope)),
    canonical,
    prefixDigest: frame.prefixDigest,
    compactedTombstones: frame.compactedTombstones,
  });
}
