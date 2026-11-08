import type {
  AppendToolResultNotesOptions,
  CanonicalMessage,
  WireFrameRecord,
} from '@paraharness/core';

/**
 * Named parameter object for `appendNotesToWireFrame`.
 *
 * Bundles the target `frame`, synchronization `notes`, optional `targetCallId`, and optional error override.
 */
export interface AppendNotesToWireFrameParams {
  /** Target `tool` or `user` wire frame record to update. */
  readonly frame: WireFrameRecord;
  /** Synchronization or grounding notes to append in-place. */
  readonly notes: readonly string[];
  /** Optional tool `callId` to target on a multi-tool `role: 'tool'` frame. */
  readonly targetCallId?: string;
  /** Optional error flag override for the updated tool result. */
  readonly opts?: AppendToolResultNotesOptions;
}

/**
 * Appends synchronization or recovery notes in-place to a `role: 'tool'` or `role: 'user'` `WireFrameRecord`.
 *
 * Re-encodes `rawWireFrame` and constructs the updated `WireFrameRecord` with a monomorphic property layout.
 *
 * @param {AppendNotesToWireFrameParams} params - Target frame, notes, optional call ID, and options.
 *
 * @returns {WireFrameRecord} Frozen updated `WireFrameRecord`.
 */
export function appendNotesToWireFrame(
  params: AppendNotesToWireFrameParams,
): WireFrameRecord {
  const { frame, notes, targetCallId, opts } = params;
  const joinedNotes = notes.join('\n');
  const prevResults = frame.canonical.toolResults ?? [];
  const nextResults: Array<{
    readonly callId: string;
    readonly content: string;
    readonly isError: boolean;
  }> = [];
  for (const tr of prevResults) {
    if (targetCallId === undefined || tr.callId === targetCallId) {
      nextResults.push(
        Object.freeze({
          callId: tr.callId,
          content: `${tr.content}\n${joinedNotes}`,
          isError: opts?.isError ?? tr.isError,
        }),
      );
    } else {
      nextResults.push(tr);
    }
  }
  const nextVisibleText =
    prevResults.length === 0
      ? `${frame.canonical.visibleText}\n${joinedNotes}`.trim()
      : frame.canonical.visibleText;
  const nextCanonical: CanonicalMessage = Object.freeze({
    role: frame.canonical.role,
    visibleText: nextVisibleText,
    toolCalls: frame.canonical.toolCalls,
    toolResults:
      nextResults.length > 0 ? Object.freeze(nextResults) : frame.canonical.toolResults,
  });
  const rawBytes = new TextEncoder().encode(JSON.stringify(nextCanonical));
  return Object.freeze<WireFrameRecord>({
    messageId: frame.messageId,
    parentMessageId: frame.parentMessageId,
    vendorId: frame.vendorId,
    rawWireFrame: rawBytes,
    canonical: nextCanonical,
    prefixDigest: frame.prefixDigest,
    compactedTombstones: frame.compactedTombstones,
  });
}
