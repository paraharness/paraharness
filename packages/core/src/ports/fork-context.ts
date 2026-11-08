import type { CompiledWirePrefix } from './compiled-wire-prefix.js';
import type { WireFrameRecord } from './wire-frame-record.js';

/**
 * Completed tool execution result for a preceding regular tool call `(1..m)` in an assistant turn
 * that also dispatches a `'clone-transcript'` downward fork.
 *
 * Enables `ModelDriver.prepareFork()` to synthesize a complete `tool_result` frame pairing all
 * tool calls `(1..k)` on `forkPointMessageId` without breaking provider call-pairing invariants.
 */
export interface PrecedingCompletedToolResult {
  /** Wire-level tool call identifier (`1..m`). */
  readonly callId: string;
  /** Serialized tool output text. */
  readonly content: string;
  /** Optional flag indicating whether the tool call returned an error. */
  readonly isError?: boolean;
}

/**
 * Context passed to `ModelDriver.prepareFork()` when initializing a downward child fork,
 * speculative branch, or cross-model `M.loop` retry escalation.
 *
 * Supplies the parent wire frame chain, fork point message ID, history mode, compiled prefix,
 * and assistant turn-batch pairing metadata.
 */
export interface ForkContext {
  /** Transcript inheritance mode (`'shared-prefix-only'` vs `'clone-transcript'`). */
  readonly historyMode: 'shared-prefix-only' | 'clone-transcript';
  /** Ordered parent `WireFrameRecord` chain up to `forkPointMessageId`. */
  readonly parentChain: readonly WireFrameRecord[];
  /** Leaf message ID in `parentChain` at which the fork branches, or `null` for clean start. */
  readonly forkPointMessageId: string | null;
  /** Optional compiled wire prefix governing the session. */
  readonly wirePrefix?: CompiledWirePrefix;
  /** Optional canonical `roleKey` of the target actor. */
  readonly roleKey?: string;
  /** Optional `[ROLE_AND_SCOPE_CONTEXT]` text (omitted on same-actor `M.loop` cross-model escalations). */
  readonly childRoleContextFrameText?: string;
  /** Optional `callId` of the `.fork()` tool call when branching mid-assistant-turn in `'clone-transcript'` mode. */
  readonly forkCallId?: string;
  /** Optional sibling `.fork()` tool call IDs in the same assistant turn batch. */
  readonly siblingForkCallIds?: readonly string[];
  /** Optional results of preceding regular tool calls `(1..m)` completed before the fork batch. */
  readonly precedingCompletedResults?: readonly PrecedingCompletedToolResult[];
  /** Optional formatted task prompt for the child fork. */
  readonly childTaskPromptText?: string;
}
