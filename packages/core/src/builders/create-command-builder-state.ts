import type { z } from 'zod';
import type { ExecutionContext } from '../ports/execution-context.js';

/**
 * Internal copy-on-write state for `createCommandBuilder`.
 *
 * Holds the optional input schema, output schema, partition extractor, and passive
 * execution callback across fluent builder transitions.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface CreateCommandBuilderState<TIn = unknown, TOut = unknown, THandle = unknown> {
  /** Input schema. */
  readonly inputSchema?: z.ZodType<TIn, z.ZodTypeDef, unknown>;
  /** Output schema. */
  readonly outputSchema?: z.ZodType<TOut, z.ZodTypeDef, unknown>;
  /** Optional partition extractor. */
  readonly extractPartitions?: (input: TIn) => readonly string[];
  /** Passive step callback. */
  readonly fn?: (input: TIn, ctx: ExecutionContext<THandle>) => Promise<TOut>;
}
