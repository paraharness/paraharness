import type {
  AppendToolResultNotesOptions,
  CanonicalMessage,
  CanonicalToolResult,
  WireFrameRecord,
} from '@paraharness/core';
import { projectCanonicalToAnthropicMessage } from './project-canonical-to-anthropic-message.js';

/**
 * Parameters for appending synchronization or recovery notes to an Anthropic `WireFrameRecord`.
 *
 * Supplies the target frame, note strings, optional `targetCallId`, and optional error flag override.
 */
export interface ClaudeAppendToolResultNotesParams {
  /** Existing `tool` or `user` wire frame record to update. */
  readonly frame: WireFrameRecord;
  /** Synchronization or recovery note strings to append. */
  readonly notes: readonly string[];
  /** Optional tool `callId` to target on a `role: 'tool'` frame. */
  readonly targetCallId: string | undefined;
  /** Optional error status override (`{ isError?: boolean }`). */
  readonly opts: AppendToolResultNotesOptions | undefined;
}

/**
 * Resolves the index of the `CanonicalToolResult` entry targeted by `targetCallId` (defaulting to the last entry).
 *
 * Falls back to `results.length - 1` when `targetCallId` is `undefined` or does not match an entry.
 *
 * @param {readonly CanonicalToolResult[]} results      - Existing tool result array on the frame.
 * @param {string | undefined}             targetCallId - Optional tool `callId` to locate.
 *
 * @returns {number} Target index inside `results`.
 */
function findClaudeTargetToolResultIndex(
  results: readonly CanonicalToolResult[],
  targetCallId: string | undefined,
): number {
  if (targetCallId === undefined) {
    return results.length - 1;
  }
  for (let idx = 0; idx < results.length; idx += 1) {
    if (results[idx]?.callId === targetCallId) {
      return idx;
    }
  }
  return results.length - 1;
}

/**
 * Appends `suffix` to a single `CanonicalToolResult` entry and applies `opts?.isError` when present.
 *
 * Returns a new frozen `CanonicalToolResult` with the updated content and error flag.
 *
 * @param {CanonicalToolResult}                    toolResult - Original tool result entry.
 * @param {string}                                 suffix     - Joined note string to append.
 * @param {AppendToolResultNotesOptions | undefined} opts     - Optional error status override.
 *
 * @returns {CanonicalToolResult} Updated frozen tool result entry.
 */
function appendSuffixToClaudeToolResult(
  toolResult: CanonicalToolResult,
  suffix: string,
  opts: AppendToolResultNotesOptions | undefined,
): CanonicalToolResult {
  const nextContent =
    toolResult.content.length > 0 ? `${toolResult.content}\n${suffix}` : suffix;
  const nextError = opts?.isError !== undefined ? opts.isError : toolResult.isError;
  return Object.freeze<CanonicalToolResult>({
    callId: toolResult.callId,
    content: nextContent,
    isError: nextError,
  });
}

/**
 * Rebuilds a `CanonicalToolResult[]` array with `suffix` appended to the entry matching `params.targetCallId` (or the last entry).
 *
 * Returns a frozen `CanonicalToolResult[]` array preserving all non-targeted tool results unchanged.
 *
 * @param {readonly CanonicalToolResult[]}    results - Existing tool result array on the frame.
 * @param {string}                            suffix  - Joined synchronization note string to append.
 * @param {ClaudeAppendToolResultNotesParams} params  - Frame, notes, optional target `callId`, and options.
 *
 * @returns {readonly CanonicalToolResult[]} Frozen updated tool result array.
 */
function rebuildClaudeToolResultsWithSuffix(
  results: readonly CanonicalToolResult[],
  suffix: string,
  params: ClaudeAppendToolResultNotesParams,
): readonly CanonicalToolResult[] {
  const targetIdx = findClaudeTargetToolResultIndex(results, params.targetCallId);
  const updatedResults: CanonicalToolResult[] = [];
  for (let idx = 0; idx < results.length; idx += 1) {
    const toolResult = results[idx];
    if (toolResult !== undefined) {
      updatedResults.push(
        idx === targetIdx
          ? appendSuffixToClaudeToolResult(toolResult, suffix, params.opts)
          : toolResult,
      );
    }
  }
  return Object.freeze(updatedResults);
}

/**
 * Projects an updated `CanonicalMessage` with `suffix` appended to either the targeted `tool` result or the `user` visible text.
 *
 * Preserves all non-targeted `CanonicalMessage` fields in a fixed monomorphic property order.
 *
 * @param {ClaudeAppendToolResultNotesParams} params - Frame, notes, optional target `callId`, and options.
 * @param {string}                            suffix - Joined synchronization note string to append.
 *
 * @returns {CanonicalMessage} Frozen updated canonical message.
 */
function appendNotesToClaudeCanonicalMessage(
  params: ClaudeAppendToolResultNotesParams,
  suffix: string,
): CanonicalMessage {
  const { frame } = params;
  if (frame.canonical.role === 'tool' && frame.canonical.toolResults !== undefined) {
    return Object.freeze<CanonicalMessage>({
      role: frame.canonical.role,
      visibleText: frame.canonical.visibleText,
      toolCalls: frame.canonical.toolCalls,
      toolResults: rebuildClaudeToolResultsWithSuffix(
        frame.canonical.toolResults,
        suffix,
        params,
      ),
    });
  }
  const nextText =
    frame.canonical.visibleText.length > 0
      ? `${frame.canonical.visibleText}\n${suffix}`
      : suffix;
  return Object.freeze<CanonicalMessage>({
    role: 'user',
    visibleText: nextText,
    toolCalls: frame.canonical.toolCalls,
    toolResults: frame.canonical.toolResults,
  });
}

/**
 * Appends synchronization or recovery notes in-place to an Anthropic `tool` or `user` `WireFrameRecord`.
 *
 * Updates both `frame.canonical` and `frame.rawWireFrame`, targeting `targetCallId` (or the last
 * `tool_result` block) on `role: 'tool'` frames and setting `is_error: true` when `opts?.isError === true`.
 *
 * @param {ClaudeAppendToolResultNotesParams} params - Frame, notes, optional target `callId`, and options.
 *
 * @returns {WireFrameRecord} Updated wire frame record with appended notes.
 */
export function claudeAppendToolResultNotes(
  params: ClaudeAppendToolResultNotesParams,
): WireFrameRecord {
  const { frame, notes } = params;
  if (notes.length === 0) {
    return frame;
  }
  const canonical = appendNotesToClaudeCanonicalMessage(params, notes.join('\n'));
  const rawWireFrame = new TextEncoder().encode(
    JSON.stringify(projectCanonicalToAnthropicMessage(canonical)),
  );
  return Object.freeze<WireFrameRecord>({
    messageId: frame.messageId,
    parentMessageId: frame.parentMessageId,
    vendorId: frame.vendorId,
    rawWireFrame,
    canonical,
    prefixDigest: frame.prefixDigest,
    compactedTombstones: frame.compactedTombstones,
  });
}
