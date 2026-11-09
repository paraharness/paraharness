import {
  DEFAULT_NODE_RUNNER_AST_NODE,
  extractAST,
  type EnvRef,
  type LocalStreamCheckNode,
  type MaybeBuilder,
  type NodeRunnerNode,
} from '@paraharness/core';
import { compileLocalStreamCheckNode } from './internal/compile-local-stream-check-node.js';
import { compileLocalStreamCheckToolBuilder } from './internal/compile-local-stream-check-tool-builder.js';
import { compileStreamCheckCircuitBreaker } from './internal/compile-stream-check-circuit-breaker.js';
import type { LocalStreamCheckBuilderState } from './internal/local-stream-check-builder-state.js';
import type {
  LocalStreamCheckBuilder,
  LocalStreamCheckCircuitBreakerOptions,
} from './local-stream-check-builder.js';

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
    runner: DEFAULT_NODE_RUNNER_AST_NODE,
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
      return createLocalStreamCheckBuilder(id, {
        ...state,
        circuitBreaker: compileStreamCheckCircuitBreaker(id, pattern, options),
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
