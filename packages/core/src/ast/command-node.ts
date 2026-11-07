import type { z } from 'zod';
import type { ExecutionContext } from '../ports/execution-context.js';
import type { BivariantCallback } from './ast-foundation.types.js';

/**
 * Passive AST node representing a deterministic TypeScript step command (`H.command(id)`).
 *
 * Carries input/output Zod validation schemas, an optional partition extractor, and a passive
 * callback `fn` invoked exclusively by the runtime's `executeCommand` `NodeExecutor` (zero `.execute` method on the node).
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface CommandNode<TIn = unknown, TOut = unknown, THandle = unknown> {
  /** Discriminant identifying a deterministic command step AST node. */
  readonly type: 'harness:command';
  /** Unique identifier of the command step. */
  readonly id: string;
  /** Zod schema validating step input before invoking `fn`. */
  readonly inputSchema: z.ZodType<TIn>;
  /** Zod schema validating step output returned by `fn`. */
  readonly outputSchema: z.ZodType<TOut>;
  /** Optional synchronous partition extractor mapping validated `TIn` to active partition IDs. */
  readonly extractPartitions?: BivariantCallback<[input: TIn], readonly string[]>;
  /** Passive step callback invoked by the runtime's `executeCommand` executor. */
  readonly fn: BivariantCallback<[input: TIn, ctx: ExecutionContext<THandle>], Promise<TOut>>;
}
