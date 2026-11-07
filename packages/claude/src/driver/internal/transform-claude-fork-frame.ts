import type { CanonicalMessage, CanonicalToolResult, WireFrameRecord } from '@harness-dsl/core';
import { projectCanonicalToAnthropicMessage } from './project-canonical-to-anthropic-message.js';
import { decodeFrameToAnthropicMessage } from './decode-frame-to-anthropic-message.js';

/**
 * Parameters for transforming a single parent `WireFrameRecord` via `transformClaudeForkFrame()`.
 *
 * Controls whether cross-model tombstone substitution is active and whether the frame is the fork point.
 */
export interface TransformClaudeForkFrameParams {
  /** Source parent wire frame record to clone or re-project. */
  readonly frame: WireFrameRecord;
  /** Whether cross-model tombstone substitution is active (`sourceModelId !== targetModelId`). */
  readonly substituteTombstones: boolean;
  /** Whether `frame` is the terminal fork-point message in the sliced parent chain. */
  readonly isForkPoint: boolean;
}

/**
 * Clones or re-projects a single parent `WireFrameRecord` during `'clone-transcript'` fork preparation.
 *
 * Preserves `rawWireFrame` with `cache_control: { type: 'ephemeral' }` on the fork point when
 * `params.substituteTombstones` is `false`, and projects from `CanonicalMessage` (applying `compactedTombstones`)
 * when `params.substituteTombstones` is `true`.
 *
 * @param {TransformClaudeForkFrameParams} params - Source frame, tombstone substitution flag, and fork-point flag.
 *
 * @returns {WireFrameRecord} Cloned or re-projected wire frame record.
 */
export function transformClaudeForkFrame(params: TransformClaudeForkFrameParams): WireFrameRecord {
  const { frame, substituteTombstones, isForkPoint } = params;
  if (!substituteTombstones) {
    if (!isForkPoint) {
      return frame;
    }
    const wireMessage = decodeFrameToAnthropicMessage(frame);
    const withCache = Object.freeze({
      ...wireMessage,
      cache_control: Object.freeze({ type: 'ephemeral' }),
    });
    return Object.freeze<WireFrameRecord>({
      messageId: frame.messageId,
      parentMessageId: frame.parentMessageId,
      vendorId: 'anthropic',
      rawWireFrame: new TextEncoder().encode(JSON.stringify(withCache)),
      canonical: frame.canonical,
      prefixDigest: frame.prefixDigest,
      compactedTombstones: frame.compactedTombstones,
    });
  }
  const tombstones = frame.compactedTombstones ?? {};
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
  const updatedCanonical = Object.freeze<CanonicalMessage>({
    role: frame.canonical.role,
    visibleText: frame.canonical.visibleText,
    toolCalls: frame.canonical.toolCalls,
    toolResults:
      frame.canonical.toolResults !== undefined ? Object.freeze(updatedResults) : undefined,
  });
  const projectedWire = projectCanonicalToAnthropicMessage(updatedCanonical);
  return Object.freeze<WireFrameRecord>({
    messageId: frame.messageId,
    parentMessageId: frame.parentMessageId,
    vendorId: 'anthropic',
    rawWireFrame: new TextEncoder().encode(JSON.stringify(projectedWire)),
    canonical: updatedCanonical,
    prefixDigest: frame.prefixDigest,
    compactedTombstones: frame.compactedTombstones,
  });
}
