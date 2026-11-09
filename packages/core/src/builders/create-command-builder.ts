import type { z } from 'zod';
import type { CommandNode } from '../ast/command-node.js';
import type { ExecutionContext } from '../ports/execution-context.js';
import type { CommandBuilder } from './command-builder.js';
import type { CommandConfigOptions } from './command-config-options.js';
import type { CreateCommandBuilderState } from './create-command-builder-state.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';

/**
 * Normalizes a 2-argument `CommandConfigOptions` record or internal `CreateCommandBuilderState` into a uniform state snapshot.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {CommandConfigOptions<TIn, TOut, THandle> | CreateCommandBuilderState<TIn, TOut, THandle>} [optionsOrState] - Direct config options or internal state.
 *
 * @returns {CreateCommandBuilderState<TIn, TOut, THandle>} Normalized command builder state.
 */
function normalizeCommandBuilderState<TIn = unknown, TOut = unknown, THandle = unknown>(
  optionsOrState?:
    | CommandConfigOptions<TIn, TOut, THandle>
    | CreateCommandBuilderState<TIn, TOut, THandle>,
): CreateCommandBuilderState<TIn, TOut, THandle> {
  if (optionsOrState !== undefined && 'input' in optionsOrState) {
    return {
      inputSchema: optionsOrState.input,
      outputSchema: optionsOrState.output,
      extractPartitions: optionsOrState.extractPartitions,
      fn: optionsOrState.fn,
    };
  }
  return {
    inputSchema: optionsOrState?.inputSchema,
    outputSchema: optionsOrState?.outputSchema,
    extractPartitions: optionsOrState?.extractPartitions,
    fn: optionsOrState?.fn,
  };
}

/**
 * Creates a fluent `CommandBuilder` for `P.command(id)` or `P.command(id, options)`.
 *
 * Supports both progressive fluent chaining (`.input()`, `.output()`, `.partitions()`, `.run()`)
 * and one-shot configuration via `CommandConfigOptions`, compiling into a deeply frozen `CommandNode`.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {string}                                                                                   id               - Unique identifier of the command step.
 * @param {CommandConfigOptions<TIn, TOut, THandle> | CreateCommandBuilderState<TIn, TOut, THandle>} [optionsOrState] - Direct config options or internal state.
 *
 * @returns {CommandBuilder<TIn, TOut, THandle>} Frozen command builder.
 */
export function createCommandBuilder<TIn = unknown, TOut = unknown, THandle = unknown>(
  id: string,
  optionsOrState?: CommandConfigOptions<TIn, TOut, THandle> | CreateCommandBuilderState<TIn, TOut, THandle>,
): CommandBuilder<TIn, TOut, THandle> {
  assertNonEmptyIdentifier('P.command', id);
  const state = normalizeCommandBuilderState(optionsOrState);

  return Object.freeze<CommandBuilder<TIn, TOut, THandle>>({
    id,
    input<TNewIn>(schema: z.ZodType<TNewIn>): CommandBuilder<TNewIn, TOut, THandle> {
      return createCommandBuilder<TNewIn, TOut, THandle>(id, {
        inputSchema: schema,
        outputSchema: state.outputSchema,
        extractPartitions: undefined,
        fn: undefined,
      });
    },
    output<TNewOut>(schema: z.ZodType<TNewOut>): CommandBuilder<TIn, TNewOut, THandle> {
      return createCommandBuilder<TIn, TNewOut, THandle>(id, {
        inputSchema: state.inputSchema,
        outputSchema: schema,
        extractPartitions: state.extractPartitions,
        fn: undefined,
      });
    },
    partitions(extractor: (input: TIn) => readonly string[]): CommandBuilder<TIn, TOut, THandle> {
      return createCommandBuilder<TIn, TOut, THandle>(id, { ...state, extractPartitions: extractor });
    },
    run<TNewHandle = THandle>(
      fn: (input: TIn, ctx: ExecutionContext<TNewHandle>) => Promise<TOut>,
    ): CommandBuilder<TIn, TOut, TNewHandle> {
      return createCommandBuilder<TIn, TOut, TNewHandle>(id, {
        inputSchema: state.inputSchema,
        outputSchema: state.outputSchema,
        extractPartitions: state.extractPartitions,
        fn,
      });
    },
    toAST(): CommandNode<TIn, TOut, THandle> {
      const missing: string[] = [];
      if (state.inputSchema === undefined) missing.push('.input(schema)');
      if (state.outputSchema === undefined) missing.push('.output(schema)');
      if (state.fn === undefined) missing.push('.run(fn)');
      if (
        missing.length > 0 ||
        state.inputSchema === undefined ||
        state.outputSchema === undefined ||
        state.fn === undefined
      ) {
        throw new Error(
          `Command '${id}' is missing required ${missing.join(', ')} configuration before .toAST().`,
        );
      }
      return deepFreeze<CommandNode<TIn, TOut, THandle>>({
        type: 'harness:command',
        id,
        inputSchema: state.inputSchema,
        outputSchema: state.outputSchema,
        extractPartitions: state.extractPartitions,
        fn: state.fn,
      });
    },
  });
}
