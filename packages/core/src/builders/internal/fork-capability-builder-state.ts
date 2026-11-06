import type { z } from 'zod';
import type { AgentNode } from '../../ast/agent-node.js';
import type { ForkModelRoutingConfig } from '../../ast/fork-capability-node.js';
import type { LoopNode } from '../../ast/loop-node.js';

/**
 * Immutable copy-on-write state snapshot backing `ForkCapabilityBuilder`.
 *
 * Captures the fork tool name, child executable, transcript history mode, request schema,
 * synchronous child input mapper, and optional model routing configuration.
 *
 * @template TParentIn Parent actor input payload type.
 * @template TReq      Validated fork request payload type.
 * @template TChildIn  Child executable input payload type.
 * @template TChildOut Child executable output payload type.
 * @template THandle   Runtime handle type of the active `BranchableScope`.
 */
export interface ForkCapabilityBuilderState<
  TParentIn = unknown,
  TReq = unknown,
  TChildIn = unknown,
  TChildOut = unknown,
  THandle = unknown,
> {
  /** Tool name exposed to the parent agent for invoking the child fork. */
  readonly toolName: string;
  /** Child agent or loop AST node executed in the forked branch. */
  readonly childExecutable:
    | AgentNode<TChildIn, TChildOut, THandle>
    | LoopNode<TChildIn, TChildOut, THandle, string>;
  /** Transcript sharing mode (`'shared-prefix-only'` or `'clone-transcript'`). */
  readonly historyMode: 'shared-prefix-only' | 'clone-transcript';
  /** Zod schema validating the parent agent's fork tool call arguments. */
  readonly requestSchema: z.ZodType<TReq, z.ZodTypeDef, unknown> | undefined;
  /** Synchronous mapper projecting `(parentInput, req)` into `TChildIn`. */
  readonly mapInput: ((parentInput: TParentIn, req: TReq) => TChildIn) | undefined;
  /** Optional conditional model routing configuration for the child session. */
  readonly modelRouting: ForkModelRoutingConfig<TParentIn, TReq> | undefined;
}

export type { ForkCapabilityBuilderState as ForkCapabilityState };
