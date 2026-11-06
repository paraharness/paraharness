import type { BaseModelASTNode } from '../base/base-model-ast-node.js';
import type { PoolNode } from '../pool-node.js';
import type { ClaudeAccountSeatNode } from './claude-account-seat-node.js';

/**
 * Passive AST node representing an Anthropic Claude model configuration (`@harness-dsl/claude`).
 *
 * Dispatched via `RuntimeExecutorRegistry.models['claude:model']` over `/v1/messages`.
 */
export interface ClaudeModelNode extends BaseModelASTNode<'claude:model', ClaudeAccountSeatNode> {
  /** Vendor discriminant for Anthropic models. */
  readonly vendor: 'anthropic';
  /** Optional reasoning effort level (`'low' | 'medium' | 'high'`). */
  readonly effort?: 'low' | 'medium' | 'high';
  /** Optional pool of Claude account seats backing this model. */
  readonly accountPool?: PoolNode<ClaudeAccountSeatNode>;
}
