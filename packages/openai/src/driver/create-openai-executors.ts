import type {
  OpenAiModelNode,
  RuntimeDriverContext,
  RuntimeExecutorRegistrySlice,
} from '@harness-dsl/core';
import { defaultOpenAiHttpTransport } from './default-openai-http-transport.constants.js';
import type { OpenAiHttpTransport } from './openai-http-transport.js';
import { OpenAiModelDriver } from './openai-model-driver.js';

/**
 * Creates a `RuntimeExecutorRegistrySlice` registering `OpenAiModelDriver` for `'openai:model'` AST nodes.
 *
 * Accepts an optional custom `OpenAiHttpTransport` for deterministic testing while defaulting to
 * `defaultOpenAiHttpTransport` in production.
 *
 * @param {OpenAiHttpTransport} [transport] - HTTP transport used by `OpenAiModelDriver`.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen executor registry slice with `models['openai:model']`.
 */
export function createOpenAiExecutors(
  transport: OpenAiHttpTransport = defaultOpenAiHttpTransport,
): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    models: Object.freeze({
      'openai:model': (node: OpenAiModelNode, ctx: RuntimeDriverContext): OpenAiModelDriver =>
        new OpenAiModelDriver(transport, node, ctx),
    }),
  });
}
