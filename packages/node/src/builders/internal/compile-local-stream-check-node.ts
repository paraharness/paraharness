import { z, type LocalStreamCheckNode } from '@metaharness/core';
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
