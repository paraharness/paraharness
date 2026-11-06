import {
  z,
  type AstBuilder,
  type LocalStreamCheckNode,
  type LocalStreamCheckToolNode,
} from '@harness-dsl/core';
import type { LocalStreamCheckBuilderState } from './local-stream-check-builder-state.js';

/**
 * Compiles `LocalStreamCheckBuilderState` into a deeply frozen `LocalStreamCheckNode`.
 *
 * Validates that `.argv(...)` has been configured and attaches the step input/output schemas
 * so `LocalStreamCheckNode` participates in both `CheckASTNode` and `StepASTNode`.
 *
 * @template THandle Isolation scope handle type.
 *
 * @param {LocalStreamCheckBuilderState} state - Current immutable builder state.
 *
 * @returns {LocalStreamCheckNode<THandle>} Frozen passive stream check AST node.
 *
 * @throws {Error} If `.argv(...)` was not configured on the builder.
 */
export function compileLocalStreamCheckNode<THandle = unknown>(
  state: LocalStreamCheckBuilderState,
): LocalStreamCheckNode<THandle> {
  if (state.argv === undefined || state.argv.length === 0) {
    throw new Error(`local.streamCheck('${state.id}') requires a non-empty .argv(...) array.`);
  }
  const outputSchema = z.object({
    ok: z.boolean(),
    deficits: z.array(z.string()).readonly(),
  });
  return Object.freeze<LocalStreamCheckNode<THandle>>({
    type: 'node:stream-check',
    id: state.id,
    inputSchema: z.unknown(),
    outputSchema,
    runner: state.runner,
    argv: Object.freeze([...state.argv]),
    env: state.env !== undefined ? Object.freeze({ ...state.env }) : undefined,
    timeoutMinutes: state.timeoutMinutes,
    circuitBreaker:
      state.circuitBreaker !== undefined ? Object.freeze({ ...state.circuitBreaker }) : undefined,
  });
}

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
  return Object.freeze({
    type: 'node:stream-check-tool' as const,
    name: checkNode.id,
    description,
    inputSchema,
    effectTracking: 'subprocess-post-flight' as const,
    check: checkNode,
    toAST(): LocalStreamCheckToolNode<THandle> {
      return toolNode;
    },
  });
}
