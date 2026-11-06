import type { z } from 'zod';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { CommandNode } from '../ast/command-node.js';
import type { ExecutionContext } from '../ports/execution-context.js';

/**
 * Fluent builder for a deterministic TypeScript step command (`H.command(id)`).
 *
 * Configures input and output Zod validation schemas, optional active partition
 * extraction, and the passive asynchronous step callback.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface CommandBuilder<TIn = unknown, TOut = unknown, THandle = unknown>
  extends AstBuilder<CommandNode<TIn, TOut, THandle>> {
  /** Unique identifier of the command step. */
  readonly id: string;

  /**
   * Binds the Zod input validation schema for the command step.
   *
   * Resets any previously bound `extractPartitions` or `run` callbacks when the input type changes.
   *
   * @template TNewIn Validated command input payload type.
   *
   * @param {z.ZodType<TNewIn, z.ZodTypeDef, unknown>} schema - Zod schema validating step input.
   *
   * @returns {CommandBuilder<TNewIn, TOut, THandle>} New immutable command builder.
   */
  input<TNewIn>(
    schema: z.ZodType<TNewIn, z.ZodTypeDef, unknown>,
  ): CommandBuilder<TNewIn, TOut, THandle>;

  /**
   * Binds the Zod output validation schema for the command step.
   *
   * Resets any previously bound `run` callback when the output type changes.
   *
   * @template TNewOut Validated command output payload type.
   *
   * @param {z.ZodType<TNewOut, z.ZodTypeDef, unknown>} schema - Zod schema validating step output.
   *
   * @returns {CommandBuilder<TIn, TNewOut, THandle>} New immutable command builder.
   */
  output<TNewOut>(
    schema: z.ZodType<TNewOut, z.ZodTypeDef, unknown>,
  ): CommandBuilder<TIn, TNewOut, THandle>;

  /**
   * Binds an optional synchronous partition extractor mapping validated `TIn` to active partition IDs.
   *
   * Populates `ResolutionContext.activePartitions` when the command step executes.
   *
   * @param {(input: TIn) => readonly string[]} extractor - Partition ID extractor callback.
   *
   * @returns {CommandBuilder<TIn, TOut, THandle>} New immutable command builder.
   */
  partitions(extractor: (input: TIn) => readonly string[]): CommandBuilder<TIn, TOut, THandle>;

  /**
   * Binds the passive asynchronous step callback executed by the runtime's `executeCommand` executor.
   *
   * Narrows the builder's scope handle type parameter to `TNewHandle`.
   *
   * @template TNewHandle Runtime handle type of the active isolation scope.
   *
   * @param {(input: TIn, ctx: ExecutionContext<TNewHandle>) => Promise<TOut>} fn - Passive step callback.
   *
   * @returns {CommandBuilder<TIn, TOut, TNewHandle>} New immutable command builder.
   */
  run<TNewHandle = THandle>(
    fn: (input: TIn, ctx: ExecutionContext<TNewHandle>) => Promise<TOut>,
  ): CommandBuilder<TIn, TOut, TNewHandle>;
}
