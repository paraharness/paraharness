import type { BaseAccountSeatASTNode } from '../base/base-account-seat-ast-node.js';
import type { EnvRef } from '../env-ref.js';

/**
 * Passive AST node representing a Google Gemini API key seat or CLI/ADC seat.
 *
 * Multiplexed inside `H.pool` with run-sticky seat affinity to preserve Gemini prefix caches.
 */
export interface GeminiAccountSeatNode extends BaseAccountSeatASTNode<'gemini:account-seat'> {
  /** Unique identifier of the Gemini account seat. */
  readonly id: string;
  /** Optional path to the Gemini CLI/ADC configuration directory. */
  readonly configDir?: string;
  /** Optional static API key string or symbolic `EnvRef`. */
  readonly apiKey?: string | EnvRef;
}
