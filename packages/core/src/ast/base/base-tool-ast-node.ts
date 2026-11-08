import type { z } from 'zod';
import type { BivariantCallback } from '../ast-foundation.types.js';

/**
 * Domain-agnostic base AST node contract for agent-invocable tools (`ToolASTNode`).
 *
 * Declares `effectTracking` (`'declared'` vs `'subprocess-post-flight'`) so `M.flow` can statically
 * verify whether an active policy guard requires a `CheckpointableScope` for post-flight diffing.
 *
 * @template TType     String-literal discriminant of the tool node.
 * @template TTracking Effect tracking mode (`'declared' | 'subprocess-post-flight'`).
 * @template THandle   Isolation scope handle type operated on by the tool.
 */
export interface BaseToolASTNode<
  TType extends string = string,
  TTracking extends 'declared' | 'subprocess-post-flight' = 'declared' | 'subprocess-post-flight',
  THandle = unknown,
> {
  /** Unique string-literal discriminant of the tool node. */
  readonly type: TType;
  /** Wire-level tool function name exposed to the LLM. */
  readonly name: string;
  /** Human- and LLM-readable description of the tool's behavior. */
  readonly description: string;
  /** Zod schema validating tool call arguments before execution. */
  readonly inputSchema: z.ZodTypeAny;
  /** Static indicator of whether effects are predicted pre-flight or diffed post-flight. */
  readonly effectTracking: TTracking;
  /** Phantom type brand binding the tool to its compatible scope handle type. */
  readonly __handleBrand?: BivariantCallback<[handle: THandle], void>;
}
