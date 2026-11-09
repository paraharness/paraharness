import {
  extractAST,
  type MaybeBuilder,
  type OpenAiAccountSeatNode,
  type OpenAiModelNode,
  type PoolNode,
} from '@paraharness/core';
import type { OpenAiModelBuilder } from './openai-model-builder.js';
import type { OpenAiModelOptions } from './openai-model-options.js';

/**
 * Creates an immutable `OpenAiModelBuilder` for an OpenAI Responses API model configuration.
 *
 * Validates that both `alias` and the resolved `modelId` (`options?.id ?? alias`) are non-empty
 * strings and compiles to a frozen passive `OpenAiModelNode` without performing network or environment I/O.
 *
 * @param {string}                                      alias         - Logical alias of the model.
 * @param {OpenAiModelOptions}                          [options]     - Optional provider model identifier and effort level.
 * @param {PoolNode<OpenAiAccountSeatNode> | undefined} [accountPool] - Optional compiled pool of OpenAI account seats.
 *
 * @returns {OpenAiModelBuilder} Immutable builder compiling to `OpenAiModelNode`.
 *
 * @throws {Error} If `alias` or `options.id` is an empty or whitespace-only string.
 */
export function createOpenAiModelBuilder(
  alias: string,
  options?: OpenAiModelOptions,
  accountPool?: PoolNode<OpenAiAccountSeatNode>,
): OpenAiModelBuilder {
  if (alias.trim().length === 0) {
    throw new Error('OpenAI model alias must be a non-empty string.');
  }
  const resolvedModelId = options?.id ?? alias;
  if (resolvedModelId.trim().length === 0) {
    throw new Error(`OpenAI model '${alias}' options.id must be a non-empty string.`);
  }
  const astNode = Object.freeze<OpenAiModelNode>({
    type: 'openai:model',
    vendor: 'openai',
    alias,
    modelId: resolvedModelId,
    effort: options?.effort,
    accountPool,
  });
  return Object.freeze<OpenAiModelBuilder>({
    alias,
    modelId: resolvedModelId,
    effort(level: 'low' | 'medium' | 'high'): OpenAiModelBuilder {
      return createOpenAiModelBuilder(alias, { id: resolvedModelId, effort: level }, accountPool);
    },
    accountPool(pool: MaybeBuilder<PoolNode<OpenAiAccountSeatNode>>): OpenAiModelBuilder {
      return createOpenAiModelBuilder(
        alias,
        { id: resolvedModelId, effort: options?.effort },
        extractAST(pool),
      );
    },
    pool(pool: MaybeBuilder<PoolNode<OpenAiAccountSeatNode>>): OpenAiModelBuilder {
      return createOpenAiModelBuilder(
        alias,
        { id: resolvedModelId, effort: options?.effort },
        extractAST(pool),
      );
    },
    toAST(): OpenAiModelNode {
      return astNode;
    },
  });
}
