import {
  extractAST,
  type ClaudeAccountSeatNode,
  type ClaudeModelNode,
  type MaybeBuilder,
  type PoolNode,
} from '@paraharness/core';
import type { ClaudeModelBuilder } from './claude-model-builder.js';
import type { ClaudeModelOptions } from './claude-model-options.js';

/**
 * Creates an immutable `ClaudeModelBuilder` for an Anthropic Claude model configuration.
 *
 * Validates that both `alias` and `options.id` are non-empty strings and compiles to a frozen
 * passive `ClaudeModelNode` without performing network or environment I/O.
 *
 * @param {string}                                      alias       - Logical alias of the model.
 * @param {ClaudeModelOptions}                          options     - Provider model identifier and optional effort level.
 * @param {PoolNode<ClaudeAccountSeatNode> | undefined} accountPool - Optional compiled pool of Claude account seats.
 *
 * @returns {ClaudeModelBuilder} Immutable builder compiling to `ClaudeModelNode`.
 *
 * @throws {Error} If `alias` or `options.id` is empty or whitespace-only.
 */
export function createClaudeModelBuilder(
  alias: string,
  options: ClaudeModelOptions,
  accountPool?: PoolNode<ClaudeAccountSeatNode>,
): ClaudeModelBuilder {
  if (alias.trim().length === 0) {
    throw new Error('Claude model alias must be a non-empty string.');
  }
  if (options.id.trim().length === 0) {
    throw new Error(`Claude model '${alias}' options.id must be a non-empty string.`);
  }
  const astNode = Object.freeze<ClaudeModelNode>({
    type: 'claude:model',
    vendor: 'anthropic',
    alias,
    modelId: options.id,
    effort: options.effort,
    accountPool,
  });
  return Object.freeze<ClaudeModelBuilder>({
    alias,
    modelId: options.id,
    effort(level: 'low' | 'medium' | 'high'): ClaudeModelBuilder {
      return createClaudeModelBuilder(alias, { id: options.id, effort: level }, accountPool);
    },
    accountPool(pool: MaybeBuilder<PoolNode<ClaudeAccountSeatNode>>): ClaudeModelBuilder {
      return createClaudeModelBuilder(alias, options, extractAST(pool));
    },
    pool(pool: MaybeBuilder<PoolNode<ClaudeAccountSeatNode>>): ClaudeModelBuilder {
      return createClaudeModelBuilder(alias, options, extractAST(pool));
    },
    toAST(): ClaudeModelNode {
      return astNode;
    },
  });
}
