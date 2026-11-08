import {
  z,
  type AstBuilder,
  type LocalStreamCheckToolNode,
} from '@paraharness/core';
import { compileLocalStreamCheckNode } from './compile-local-stream-check-node.js';
import type { LocalStreamCheckBuilderState } from './local-stream-check-builder-state.js';

/**
 * Projects a `LocalStreamCheckBuilderState` into a post-flight-diffed `LocalStreamCheckToolNode` builder.
 *
 * Sets `effectTracking: 'subprocess-post-flight'` and binds an empty object input schema.
 *
 * @template THandle Isolation scope handle type.
 *
 * @param {LocalStreamCheckBuilderState} state - Current immutable builder state.
 *
 * @returns {AstBuilder<LocalStreamCheckToolNode<THandle>> & LocalStreamCheckToolNode<THandle>} Frozen tool builder and descriptor.
 *
 * @throws {Error} If `.argv(...)` was not configured on the builder.
 */
export function compileLocalStreamCheckToolBuilder<THandle = unknown>(
  state: LocalStreamCheckBuilderState,
): AstBuilder<LocalStreamCheckToolNode<THandle>> & LocalStreamCheckToolNode<THandle> {
  const checkNode = compileLocalStreamCheckNode<THandle>(state);
  const inputSchema = z.object({});
  const description = `Run streaming verification check ${checkNode.id}`;
  const toolNode = Object.freeze<LocalStreamCheckToolNode<THandle>>({
    type: 'node:stream-check-tool',
    name: checkNode.id,
    description,
    inputSchema,
    effectTracking: 'subprocess-post-flight',
    check: checkNode,
  });
  return Object.freeze<AstBuilder<LocalStreamCheckToolNode<THandle>> & LocalStreamCheckToolNode<THandle>>({
    type: 'node:stream-check-tool',
    name: checkNode.id,
    description,
    inputSchema,
    effectTracking: 'subprocess-post-flight',
    check: checkNode,
    toAST(): LocalStreamCheckToolNode<THandle> {
      return toolNode;
    },
  });
}
