import {
  extractAST,
  type EnvRef,
  type LocalStreamCheckNode,
  type MaybeBuilder,
  type NodeRunnerNode,
} from '@harness-dsl/core';
import {
  compileLocalStreamCheckNode,
  compileLocalStreamCheckToolBuilder,
} from './internal/compile-local-stream-check-ast.js';
import type { LocalStreamCheckBuilderState } from './internal/local-stream-check-builder-state.js';
import type { LocalStreamCheckBuilder } from './local-stream-check-builder.js';
import type { LocalStreamCheckCircuitBreakerOptions } from './local-stream-check-circuit-breaker-options.js';

/**
 * Creates a fluent `LocalStreamCheckBuilder` for `local.streamCheck(id)`.
 *
 * Initializes default runner configuration and provides immutable chaining methods for
 * `argv`, `env`, `timeoutMinutes`, `circuitBreakWhenStdout`, and `asTool`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {string}                       id              - Unique identifier of the streaming check.
 * @param {LocalStreamCheckBuilderState} [existingState] - Internal state for immutable cloning.
 *
 * @returns {LocalStreamCheckBuilder<THandle>} Frozen fluent stream check builder.
 *
 * @throws {Error} If `id` is empty or whitespace-only.
 */
export function createLocalStreamCheckBuilder<THandle = unknown>(
  id: string,
  existingState?: LocalStreamCheckBuilderState,
): LocalStreamCheckBuilder<THandle> {
  if (id.trim().length === 0) {
    throw new Error('local.streamCheck requires a non-empty check id.');
  }
  const state: LocalStreamCheckBuilderState = existingState ?? {
    id,
    runner: Object.freeze<NodeRunnerNode>({
      type: 'node:runner',
      id: 'default-runner',
      slots: 4,
      maxDaemons: 4,
    }),
    argv: undefined,
    env: undefined,
    timeoutMinutes: undefined,
    circuitBreaker: undefined,
  };
  return Object.freeze<LocalStreamCheckBuilder<THandle>>({
    id,
    runner(runner: MaybeBuilder<NodeRunnerNode>): LocalStreamCheckBuilder<THandle> {
      return createLocalStreamCheckBuilder(id, { ...state, runner: extractAST(runner) });
    },
    argv(args: readonly string[]): LocalStreamCheckBuilder<THandle> {
      return createLocalStreamCheckBuilder(id, { ...state, argv: Object.freeze([...args]) });
    },
    env(envVars: Readonly<Record<string, string | EnvRef>>): LocalStreamCheckBuilder<THandle> {
      return createLocalStreamCheckBuilder(id, { ...state, env: Object.freeze({ ...envVars }) });
    },
    timeoutMinutes(minutes: number): LocalStreamCheckBuilder<THandle> {
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error(`local.streamCheck('${id}').timeoutMinutes requires a positive number.`);
      }
      return createLocalStreamCheckBuilder(id, { ...state, timeoutMinutes: minutes });
    },
    circuitBreakWhenStdout(
      pattern: RegExp | string,
      options: LocalStreamCheckCircuitBreakerOptions,
    ): LocalStreamCheckBuilder<THandle> {
      if (!Number.isInteger(options.graceLinesAfterMatch) || options.graceLinesAfterMatch < 0) {
        throw new Error(
          `local.streamCheck('${id}').circuitBreakWhenStdout requires non-negative integer graceLinesAfterMatch.`,
        );
      }
      const source = typeof pattern === 'string' ? pattern : pattern.source;
      const flags = typeof pattern === 'string' || pattern.flags.length === 0 ? undefined : pattern.flags;
      return createLocalStreamCheckBuilder(id, {
        ...state,
        circuitBreaker: Object.freeze({
          pattern: source,
          flags,
          graceLinesAfterMatch: options.graceLinesAfterMatch,
        }),
      });
    },
    asTool() {
      return compileLocalStreamCheckToolBuilder<THandle>(state);
    },
    toAST(): LocalStreamCheckNode<THandle> {
      return compileLocalStreamCheckNode<THandle>(state);
    },
  });
}
