import type { z } from 'zod';
import type { AgentNode } from './agent-node.js';
import type { BivariantCallback } from './ast-foundation.types.js';
import type { ModelASTNode } from './domain-ast.types.js';
import type { LoopNode } from './loop-node.js';
import type { PoolNode } from './pool-node.js';

/**
 * Conditional model routing configuration for downward child forks (`.modelRouting($m => ...)`).
 *
 * Evaluates whether the child fork should inherit the parent actor's bound model at a specific
 * reasoning effort or route to an explicit fallback model or pool.
 *
 * @template TParentIn Parent actor input payload type.
 * @template TReq      Fork tool call request payload type.
 */
export interface ForkModelRoutingConfig<TParentIn = unknown, TReq = unknown> {
  /** Optional rule inheriting the parent actor's model with a specified reasoning effort when `when(parentInput, req)` holds. */
  readonly inheritParentEffort?: {
    readonly effort: 'low' | 'medium' | 'high';
    readonly when: BivariantCallback<[parentInput: TParentIn, req: TReq], boolean>;
  };
  /** Fallback model or model pool used when `inheritParentEffort` is not matched. */
  readonly otherwisePool: ModelASTNode | PoolNode<ModelASTNode>;
}

/**
 * Passive AST node representing a downward child fork capability tool (`$cap.fork(toolName, childExecutable, $f => ...)`).
 *
 * Spawns an isolated child scope branch when invoked by the parent agent, executes `childExecutable`
 * over `mapInput(parentInput, req)`, and commits or reconciles the child scope upon completion.
 *
 * @template TParentIn Parent actor input payload type.
 * @template TReq      Validated fork tool request payload type.
 * @template TChildIn  Child executable input payload type.
 * @template TChildOut Child executable output payload type.
 * @template THandle   Runtime handle type of the active `BranchableScope`.
 */
export interface ForkCapabilityNode<
  TParentIn = unknown,
  TReq = unknown,
  TChildIn = unknown,
  TChildOut = unknown,
  THandle = unknown,
> {
  /** Discriminant identifying a downward fork capability AST node. */
  readonly type: 'harness:fork-capability';
  /** Tool name exposed to the parent agent for invoking this downward fork. */
  readonly toolName: string;
  /** Child agent or loop executable invoked inside the forked child isolation scope. */
  readonly childExecutable:
    | AgentNode<TChildIn, TChildOut, THandle>
    | LoopNode<TChildIn, TChildOut, THandle, string>;
  /** Transcript history sharing mode (`'shared-prefix-only'` default or `'clone-transcript'`). */
  readonly historyMode: 'shared-prefix-only' | 'clone-transcript';
  /** Zod schema validating the parent agent's fork tool call arguments. */
  readonly requestSchema: z.ZodType<TReq>;
  /** Synchronous mapper projecting `(parentInput, req)` into the child executable's input `TChildIn`. */
  readonly mapInput: BivariantCallback<[parentInput: TParentIn, req: TReq], TChildIn>;
  /** Optional dynamic model routing configuration for child forks. */
  readonly modelRouting?: ForkModelRoutingConfig<TParentIn, TReq>;
}
