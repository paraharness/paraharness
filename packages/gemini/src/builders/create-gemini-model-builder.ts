import {
  extractAST,
  type GeminiAccountSeatNode,
  type GeminiModelNode,
  type MaybeBuilder,
  type PoolNode,
} from '@paraharness/core';
import type { GeminiModelBuilder } from './gemini-model-builder.js';
import type { GeminiModelOptions } from './gemini-model-options.js';

/**
 * Creates an immutable `GeminiModelBuilder` for a Google Gemini model configuration.
 *
 * Validates that both `alias` and the resolved `modelId` (`options?.id ?? alias`) are non-empty
 * strings and compiles to a frozen passive `GeminiModelNode` without performing network or environment I/O.
 *
 * @param {string}                                      alias         - Logical alias of the model.
 * @param {GeminiModelOptions}                          [options]     - Optional provider model identifier and effort level.
 * @param {PoolNode<GeminiAccountSeatNode> | undefined} [accountPool] - Optional compiled pool of Gemini account seats.
 *
 * @returns {GeminiModelBuilder} Immutable builder compiling to `GeminiModelNode`.
 *
 * @throws {Error} If `alias` or `options.id` is an empty or whitespace-only string.
 */
export function createGeminiModelBuilder(
  alias: string,
  options?: GeminiModelOptions,
  accountPool?: PoolNode<GeminiAccountSeatNode>,
): GeminiModelBuilder {
  if (alias.trim().length === 0) {
    throw new Error('Gemini model alias must be a non-empty string.');
  }
  const resolvedModelId = options?.id ?? alias;
  if (resolvedModelId.trim().length === 0) {
    throw new Error(`Gemini model '${alias}' options.id must be a non-empty string.`);
  }
  const astNode = Object.freeze<GeminiModelNode>({
    type: 'gemini:model',
    vendor: 'google',
    alias,
    modelId: resolvedModelId,
    effort: options?.effort,
    accountPool,
  });
  return Object.freeze<GeminiModelBuilder>({
    alias,
    modelId: resolvedModelId,
    effort(level: 'low' | 'medium' | 'high'): GeminiModelBuilder {
      return createGeminiModelBuilder(alias, { id: resolvedModelId, effort: level }, accountPool);
    },
    pool(pool: MaybeBuilder<PoolNode<GeminiAccountSeatNode>>): GeminiModelBuilder {
      return createGeminiModelBuilder(
        alias,
        { id: resolvedModelId, effort: options?.effort },
        extractAST(pool),
      );
    },
    accountPool(pool: MaybeBuilder<PoolNode<GeminiAccountSeatNode>>): GeminiModelBuilder {
      return createGeminiModelBuilder(
        alias,
        { id: resolvedModelId, effort: options?.effort },
        extractAST(pool),
      );
    },
    toAST(): GeminiModelNode {
      return astNode;
    },
  });
}
