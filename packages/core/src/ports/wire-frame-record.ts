import type { CanonicalMessage } from './canonical-message.js';

/**
 * Immutable ledger record capturing both the exact vendor wire payload (`rawWireFrame`)
 * and its vendor-neutral `CanonicalMessage` projection.
 *
 * Preserves cryptographic reasoning state (Anthropic `thinking` signatures, OpenAI
 * `encrypted_content`, and Gemini `thoughtSignature` fields) across same-model turns and forks.
 */
export interface WireFrameRecord {
  /** Unique identifier of this message frame in `LedgerStore`. */
  readonly messageId: string;
  /** Identifier of the preceding message frame in the conversation chain, or `null` for Turn 0. */
  readonly parentMessageId: string | null;
  /** Provider vendor identifier (`'anthropic'`, `'openai'`, `'google'`, or custom vendor string). */
  readonly vendorId: string;
  /** Exact UTF-8 encoded provider wire JSON payload for zero-invalidation KV cache replay. */
  readonly rawWireFrame: Uint8Array;
  /** Vendor-neutral canonical projection of the message frame. */
  readonly canonical: CanonicalMessage;
  /** SHA-256 hex digest of the compiled wire prefix active when this frame was recorded. */
  readonly prefixDigest: string;
  /** Optional map of `callId` to compacted tombstone text populated when `completeSkill` unmounts a skill. */
  readonly compactedTombstones?: Readonly<Record<string, string>>;
}
