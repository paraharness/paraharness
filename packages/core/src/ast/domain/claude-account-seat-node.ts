import type { BaseAccountSeatASTNode } from '../base/base-account-seat-ast-node.js';
import type { EnvRef } from '../env-ref.js';

/**
 * Passive AST node representing an Anthropic Claude CLI subscription seat or API key seat.
 *
 * Multiplexed inside `M.pool` with run-sticky seat affinity to preserve Anthropic KV prefix caches.
 */
export interface ClaudeAccountSeatNode extends BaseAccountSeatASTNode<'claude:account-seat'> {
  /** Unique identifier of the Claude account seat. */
  readonly id: string;
  /** Optional path to the Claude CLI configuration directory containing OAuth credentials. */
  readonly configDir?: string;
  /** Optional static API key string or symbolic `EnvRef` for fallback API seats. */
  readonly apiKey?: string | EnvRef;
}
