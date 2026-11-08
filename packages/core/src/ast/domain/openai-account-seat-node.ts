import type { BaseAccountSeatASTNode } from '../base/base-account-seat-ast-node.js';
import type { EnvRef } from '../env-ref.js';

/**
 * Passive AST node representing an OpenAI API key seat or Codex CLI subscription seat.
 *
 * Multiplexed inside `P.pool` with run-sticky seat affinity and automatic cross-seat failover stripping
 * of account-bound `previous_response_id` and `encrypted_content` fields.
 */
export interface OpenAiAccountSeatNode extends BaseAccountSeatASTNode<'openai:account-seat'> {
  /** Unique identifier of the OpenAI account seat. */
  readonly id: string;
  /** Optional path to the Codex CLI configuration directory. */
  readonly configDir?: string;
  /** Optional static API key string or symbolic `EnvRef`. */
  readonly apiKey?: string | EnvRef;
}
