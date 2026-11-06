/**
 * Vendor-neutral tool call invocation block inside a `CanonicalMessage`.
 *
 * Normalizes provider-specific tool call identifiers, function names, and JSON argument strings.
 */
export interface CanonicalToolCall {
  /** Unique wire-level identifier for this tool call (`callId`). */
  readonly id: string;
  /** Name of the tool invoked by the assistant. */
  readonly name: string;
  /** Raw JSON-serialized tool arguments object. */
  readonly argsJson: string;
}

/**
 * Vendor-neutral tool execution result block inside a `CanonicalMessage`.
 *
 * Pairs a completed or rejected tool execution back to its originating `CanonicalToolCall.id`.
 */
export interface CanonicalToolResult {
  /** Identifier of the `CanonicalToolCall` paired by this result. */
  readonly callId: string;
  /** Serialized text output or error message returned by the tool. */
  readonly content: string;
  /** Whether the tool execution resulted in an error (`true` maps to wire-level error markers). */
  readonly isError: boolean;
}

/**
 * Vendor-neutral projection of a conversation turn frame stored alongside `rawWireFrame`.
 *
 * Used for cross-model escalations (`substituteTombstones: true`), turn completion detection,
 * and deterministic tool call orchestration.
 */
export interface CanonicalMessage {
  /** Role of the message author in the conversation transcript. */
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  /** Visible plain-text content of the message. */
  readonly visibleText: string;
  /** Optional assistant tool call requests emitted in this turn. */
  readonly toolCalls?: readonly CanonicalToolCall[];
  /** Optional tool execution results paired in this turn. */
  readonly toolResults?: readonly CanonicalToolResult[];
}
