import type { BaseModelASTNode } from '../base/base-model-ast-node.js';
import type { PoolNode } from '../pool-node.js';
import type { OpenAiAccountSeatNode } from './openai-account-seat-node.js';

/**
 * Passive AST node representing an OpenAI Responses API model configuration (`@harness-dsl/openai`).
 *
 * Dispatched via `RuntimeExecutorRegistry.models['openai:model']`.
 */
export interface OpenAiModelNode extends BaseModelASTNode<'openai:model', OpenAiAccountSeatNode> {
  /** Vendor discriminant for OpenAI models. */
  readonly vendor: 'openai';
  /** Optional reasoning effort level (`'low' | 'medium' | 'high'`). */
  readonly effort?: 'low' | 'medium' | 'high';
  /** Optional pool of OpenAI account seats backing this model. */
  readonly accountPool?: PoolNode<OpenAiAccountSeatNode>;
}
