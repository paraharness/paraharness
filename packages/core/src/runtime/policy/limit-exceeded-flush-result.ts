import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';

/**
 * Outcome returned by `executeLimitExceededSequence()` after completing Steps 1–4 (`SPEC.md` §3.5).
 *
 * Carries the validated `flushInterrupt` payload, `abortHook` metadata, updated leaf message ID,
 * and final `AgentContinuationFrame`.
 */
export interface LimitExceededFlushResult {
  /** Identifier of the flushed `InterruptNode`. */
  readonly interruptId: string;
  /** Validated structured output payload produced by the `toolChoice: 'none'` epistemic flush turn. */
  readonly flushedPayload: unknown;
  /** Metadata record returned by `abortHook` (or `{}` when restored via checkpoint). */
  readonly abortMeta: Record<string, unknown>;
  /** Updated leaf message ID in `LedgerStore` after the epistemic flush turn. */
  readonly leafMessageId: string | null;
  /** Final `AgentContinuationFrame` reflecting `LIMIT_EXCEEDED_FLUSH` completion. */
  readonly updatedAgentFrame: AgentContinuationFrame;
}
