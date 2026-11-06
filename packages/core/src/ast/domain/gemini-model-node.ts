import type { BaseModelASTNode } from '../base/base-model-ast-node.js';
import type { PoolNode } from '../pool-node.js';
import type { GeminiAccountSeatNode } from './gemini-account-seat-node.js';

/**
 * Passive AST node representing a Google Gemini model configuration (`@harness-dsl/gemini`).
 *
 * Dispatched via `RuntimeExecutorRegistry.models['gemini:model']` over `/v1beta/models/{model}:generateContent`.
 */
export interface GeminiModelNode extends BaseModelASTNode<'gemini:model', GeminiAccountSeatNode> {
  /** Vendor discriminant for Google Gemini models. */
  readonly vendor: 'google';
  /** Optional thinking level (`'low' | 'medium' | 'high'`). */
  readonly effort?: 'low' | 'medium' | 'high';
  /** Optional pool of Gemini account seats backing this model. */
  readonly accountPool?: PoolNode<GeminiAccountSeatNode>;
}
