/**
 * Pause state on `agent-frame` during `.onLimitExceeded()` epistemic flush or `.replaceWith()` abort cleanup.
 *
 * Tracks whether `[LIMIT_EXCEEDED_FLUSH]` was injected, the flushed interrupt payload, and `abortMetaJson`.
 */
export interface InterruptFlushPauseState {
  /** Discriminant identifying a limit-exceeded flush or step-replacement abort sequence. */
  readonly kind: 'interrupt-flush';
  /** Identifier of the flush or replacement `InterruptNode`. */
  readonly interruptId: string;
  /** Whether the `[LIMIT_EXCEEDED_FLUSH]` prompt has already been injected into the transcript. */
  readonly flushPromptInjected?: boolean;
  /** Optional JSON-serialized interrupt payload produced by the `toolChoice: 'none'` flush turn. */
  readonly flushedInterruptPayloadJson?: string;
  /** Optional JSON-serialized metadata returned by the executed `AbortHookASTNode`. */
  readonly abortMetaJson?: string;
}
