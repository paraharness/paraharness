import type {
  GeminiModelNode,
  RuntimeDriverContext,
  RuntimeExecutorRegistrySlice,
} from '@harness-dsl/core';
import { defaultGeminiHttpTransport } from './default-gemini-http-transport.constants.js';
import type { GeminiHttpTransport } from './gemini-http-transport.js';
import { GeminiModelDriver } from './gemini-model-driver.js';

/**
 * Creates a `RuntimeExecutorRegistrySlice` registering `GeminiModelDriver` for `'gemini:model'` AST nodes.
 *
 * Accepts an optional custom `GeminiHttpTransport` for deterministic testing while defaulting to
 * `defaultGeminiHttpTransport` in production.
 *
 * @param {GeminiHttpTransport} [transport] - HTTP transport used by `GeminiModelDriver`.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen executor registry slice with `models['gemini:model']`.
 */
export function createGeminiExecutors(
  transport: GeminiHttpTransport = defaultGeminiHttpTransport,
): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    models: Object.freeze({
      'gemini:model': (node: GeminiModelNode, ctx: RuntimeDriverContext): GeminiModelDriver =>
        new GeminiModelDriver(transport, node, ctx),
    }),
  });
}
