import {
  extractAST,
  z,
  type BivariantCallback,
  type EnvRef,
  type LocalCommandNode,
  type MaybeBuilder,
  type NodeRunnerNode,
} from '@harness-dsl/core';
import {
  compileLocalCommandCheckBuilder,
  compileLocalCommandNode,
  compileLocalCommandToolBuilder,
  normalizeUnrepeatablePreCheckNode,
} from './internal/compile-local-command-ast.js';
import type { LocalCommandBuilderState } from './internal/local-command-builder-state.js';
import type { LocalCommandBuilder } from './local-command-builder.js';
import type { LocalCommandUnrepeatableOptions } from './local-command-unrepeatable-options.js';

/**
 * Creates a fluent `LocalCommandBuilder` for `local.command(id)`.
 *
 * Initializes default `z.unknown()` input and output schemas, `'closed'` standard input mode,
 * and a default runner pool descriptor so fluent chaining remains immutable and type-safe.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {string}                                       id              - Unique identifier of the command.
 * @param {LocalCommandBuilderState<TIn, TOut, THandle>} [existingState] - Internal state for immutable cloning.
 *
 * @returns {LocalCommandBuilder<TIn, TOut, THandle>} Frozen fluent command builder.
 *
 * @throws {Error} If `id` is empty or whitespace-only.
 */
export function createLocalCommandBuilder<TIn = unknown, TOut = unknown, THandle = unknown>(
  id: string,
  existingState?: LocalCommandBuilderState<TIn, TOut, THandle>,
): LocalCommandBuilder<TIn, TOut, THandle> {
  if (id.trim().length === 0) throw new Error('local.command requires a non-empty command id.');
  const state: LocalCommandBuilderState<TIn, TOut, THandle> = existingState ?? {
    id,
    runner: Object.freeze<NodeRunnerNode>({ type: 'node:runner', id: 'default-runner', slots: 4, maxDaemons: 4 }),
    argv: undefined,
    stdinMode: 'closed',
    env: undefined,
    timeoutMinutes: undefined,
    inputSchema: z.custom<TIn>(() => true),
    hasExplicitInputSchema: false,
    outputSchema: z.custom<TOut>(() => true),
    unrepeatable: undefined,
  };
  return Object.freeze<LocalCommandBuilder<TIn, TOut, THandle>>({
    id,
    runner(runner: MaybeBuilder<NodeRunnerNode>): LocalCommandBuilder<TIn, TOut, THandle> {
      return createLocalCommandBuilder(id, { ...state, runner: extractAST(runner) });
    },
    stdin(mode: 'closed' | BivariantCallback<[input: TIn], string | Uint8Array>): LocalCommandBuilder<TIn, TOut, THandle> {
      return createLocalCommandBuilder(id, { ...state, stdinMode: mode });
    },
    env(envVars: Readonly<Record<string, string | EnvRef>>): LocalCommandBuilder<TIn, TOut, THandle> {
      return createLocalCommandBuilder(id, { ...state, env: Object.freeze({ ...envVars }) });
    },
    argv(args: readonly string[] | BivariantCallback<[input: TIn], readonly string[]>): LocalCommandBuilder<TIn, TOut, THandle> {
      return createLocalCommandBuilder(id, { ...state, argv: args });
    },
    timeoutMinutes(minutes: number): LocalCommandBuilder<TIn, TOut, THandle> {
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error(`local.command('${id}').timeoutMinutes requires a positive number.`);
      }
      return createLocalCommandBuilder(id, { ...state, timeoutMinutes: minutes });
    },
    input<TNewIn>(schema: z.ZodType<TNewIn, z.ZodTypeDef, unknown>): LocalCommandBuilder<TNewIn, TOut, THandle> {
      const preservedArgv = typeof state.argv === 'function' ? undefined : state.argv;
      return createLocalCommandBuilder<TNewIn, TOut, THandle>(id, {
        ...state,
        argv: preservedArgv,
        stdinMode: 'closed',
        inputSchema: schema,
        hasExplicitInputSchema: true,
        unrepeatable: undefined,
      });
    },
    output<TNewOut>(schema: z.ZodType<TNewOut, z.ZodTypeDef, unknown>): LocalCommandBuilder<TIn, TNewOut, THandle> {
      return createLocalCommandBuilder<TIn, TNewOut, THandle>(id, { ...state, outputSchema: schema });
    },
    unrepeatable<TPreIn = TIn>(
      preCheckCmd: MaybeBuilder<LocalCommandNode<TPreIn, boolean, THandle>>,
      options: LocalCommandUnrepeatableOptions<TIn>,
    ): LocalCommandBuilder<TIn, TOut, THandle> {
      return createLocalCommandBuilder(id, {
        ...state,
        unrepeatable: Object.freeze({ preCheckCmd: normalizeUnrepeatablePreCheckNode(preCheckCmd), key: options.key }),
      });
    },
    asCheck() {
      return compileLocalCommandCheckBuilder(compileLocalCommandNode(state));
    },
    asTool() {
      return compileLocalCommandToolBuilder(state);
    },
    toAST(): LocalCommandNode<TIn, TOut, THandle> {
      return compileLocalCommandNode(state);
    },
  });
}
