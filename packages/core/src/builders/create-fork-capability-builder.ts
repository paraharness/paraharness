import type { AgentNode } from '../ast/agent-node.js';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type { LoopNode } from '../ast/loop-node.js';
import type { ForkCapabilityBuilder } from './fork-capability-builder.js';
import { createForkCapabilityFromState } from './internal/capability-sub-builders.js';
import { assertNonEmptyIdentifier } from './internal/deep-freeze.js';

/**
 * Creates a fluent `ForkCapabilityBuilder` for `$cap.fork(toolName, childExecutable, $f => ...)`.
 *
 * Validates that `toolName` is non-empty and initializes `historyMode` to `'shared-prefix-only'`.
 *
 * @template TParentIn Parent actor input payload type.
 * @template TChildIn  Child executable input payload type.
 * @template TChildOut Child executable output payload type.
 * @template THandle   Isolation scope handle type.
 *
 * @param {string}                                                                                                 toolName        - Tool name exposed to the parent agent.
 * @param {MaybeBuilder<AgentNode<TChildIn, TChildOut, THandle> | LoopNode<TChildIn, TChildOut, THandle, string>>} childExecutable - Child agent or loop.
 *
 * @returns {ForkCapabilityBuilder<TParentIn, unknown, TChildIn, TChildOut, THandle>} Frozen fork capability builder.
 */
export function createForkCapabilityBuilder<
  TParentIn = unknown,
  TChildIn = unknown,
  TChildOut = unknown,
  THandle = unknown,
>(
  toolName: string,
  childExecutable: MaybeBuilder<
    AgentNode<TChildIn, TChildOut, THandle> | LoopNode<TChildIn, TChildOut, THandle, string>
  >,
): ForkCapabilityBuilder<TParentIn, unknown, TChildIn, TChildOut, THandle> {
  assertNonEmptyIdentifier('H.agent.capabilities.fork', toolName);
  return createForkCapabilityFromState({
    toolName,
    childExecutable: extractAST(childExecutable),
    historyMode: 'shared-prefix-only',
    requestSchema: undefined,
    mapInput: undefined,
    modelRouting: undefined,
  });
}
