import type { z } from 'zod';
import type { ExecutionContext } from '../ports/execution-context.js';

/**
 * Direct configuration object accepted by the 2-argument `M.command(id, options)` overload.
 *
 * Bundles the input Zod schema, output Zod schema, optional partition extractor, and
 * passive execution callback into a single options object.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface CommandConfigOptions<TIn = unknown, TOut = unknown, THandle = unknown> {
  /** Zod schema validating step input before invoking `fn`. */
  readonly input: z.ZodType<TIn>;
  /** Zod schema validating step output returned by `fn`. */
  readonly output: z.ZodType<TOut>;
  /** Optional synchronous partition extractor mapping validated `TIn` to active partition IDs. */
  readonly extractPartitions?: (input: TIn) => readonly string[];
  /** Passive step callback invoked by the runtime's `executeCommand` executor. */
  readonly fn: (input: TIn, ctx: ExecutionContext<THandle>) => Promise<TOut>;
}
