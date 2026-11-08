import type {
  ClaudeModelNode,
  RuntimeDriverContext,
  RuntimeExecutorRegistrySlice,
} from '@metaharness/core';
import type { ClaudeHttpTransport } from './claude-http-transport.js';
import { ClaudeModelDriver } from './claude-model-driver.js';
import { defaultClaudeHttpTransport } from './default-claude-http-transport.constants.js';

/**
 * Creates a `RuntimeExecutorRegistrySlice` registering `ClaudeModelDriver` for `'claude:model'` AST nodes.
 *
 * Accepts an optional custom `ClaudeHttpTransport` for deterministic testing while defaulting to
 * `defaultClaudeHttpTransport` in production.
 *
 * @param {ClaudeHttpTransport} [transport=defaultClaudeHttpTransport] - HTTP transport used by `ClaudeModelDriver`.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen executor registry slice with `models['claude:model']`.
 */
export function createClaudeExecutors(
  transport: ClaudeHttpTransport = defaultClaudeHttpTransport,
): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    models: Object.freeze({
      'claude:model': (node: ClaudeModelNode, ctx: RuntimeDriverContext): ClaudeModelDriver =>
        new ClaudeModelDriver(transport, node, ctx),
    }),
  });
}
