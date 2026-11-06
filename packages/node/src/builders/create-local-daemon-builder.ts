import {
  extractAST,
  type LocalServiceNode,
  type MaybeBuilder,
  type NodeRunnerNode,
} from '@harness-dsl/core';
import {
  compileDaemonInteractionConfig,
  compileLocalDaemonNode,
  normalizeRegexDescriptor,
} from './internal/compile-local-daemon-ast.js';
import type { LocalDaemonBuilderState } from './internal/local-daemon-builder-state.js';
import type { LocalDaemonBuilder } from './local-daemon-builder.js';
import type {
  LocalDaemonCommandContext,
  LocalDaemonInteractOptions,
} from './local-daemon-interact-options.js';

/**
 * Creates a fluent `LocalDaemonBuilder` for `local.daemon(id)`.
 *
 * Initializes default runner pool, `'skill'` lifecycle, and empty port/interaction lists,
 * returning an immutable builder that compiles to a passive `LocalServiceNode`.
 *
 * @param {string}                  id              - Unique identifier of the daemon service.
 * @param {LocalDaemonBuilderState} [existingState] - Internal state for immutable cloning.
 *
 * @returns {LocalDaemonBuilder} Frozen fluent daemon builder.
 *
 * @throws {Error} If `id` is empty or whitespace-only.
 */
export function createLocalDaemonBuilder(
  id: string,
  existingState?: LocalDaemonBuilderState,
): LocalDaemonBuilder {
  if (id.trim().length === 0) {
    throw new Error('local.daemon requires a non-empty service id.');
  }
  const state: LocalDaemonBuilderState = existingState ?? {
    id,
    runner: Object.freeze<NodeRunnerNode>({
      type: 'node:runner',
      id: 'default-runner',
      slots: 4,
      maxDaemons: 4,
    }),
    lifecycle: 'skill',
    ports: Object.freeze([]),
    startArgv: undefined,
    stopArgv: undefined,
    readyWhenStdoutRegex: undefined,
    interactions: Object.freeze([]),
  };
  return Object.freeze<LocalDaemonBuilder>({
    id,
    runner(runner: MaybeBuilder<NodeRunnerNode>): LocalDaemonBuilder {
      return createLocalDaemonBuilder(id, { ...state, runner: extractAST(runner) });
    },
    lifecycle(mode: 'scope' | 'fork' | 'skill'): LocalDaemonBuilder {
      return createLocalDaemonBuilder(id, { ...state, lifecycle: mode });
    },
    port(name: string): LocalDaemonBuilder {
      if (name.trim().length === 0) {
        throw new Error(`local.daemon('${id}').port requires a non-empty port name.`);
      }
      const nextPorts = state.ports.includes(name) ? state.ports : [...state.ports, name];
      return createLocalDaemonBuilder(id, { ...state, ports: Object.freeze(nextPorts) });
    },
    start(startFn: (ctx: LocalDaemonCommandContext) => readonly string[]): LocalDaemonBuilder {
      return createLocalDaemonBuilder(id, { ...state, startArgv: startFn });
    },
    stopCommand(stopFn: (ctx: LocalDaemonCommandContext) => readonly string[]): LocalDaemonBuilder {
      return createLocalDaemonBuilder(id, { ...state, stopArgv: stopFn });
    },
    readyWhenStdout(pattern: RegExp | string): LocalDaemonBuilder {
      return createLocalDaemonBuilder(id, {
        ...state,
        readyWhenStdoutRegex: normalizeRegexDescriptor(pattern),
      });
    },
    interact<TInput = { readonly input: string }>(
      toolName: string,
      options: LocalDaemonInteractOptions<TInput>,
    ): LocalDaemonBuilder {
      const compiled = compileDaemonInteractionConfig(toolName, options);
      return createLocalDaemonBuilder(id, {
        ...state,
        interactions: Object.freeze([...state.interactions, compiled]),
      });
    },
    toAST(): LocalServiceNode {
      return compileLocalDaemonNode(state);
    },
  });
}
