import {
  z,
  type LocalServiceInteractionConfig,
  type LocalServiceNode,
  type ServiceToolSchemaDescriptor,
} from '@harness-dsl/core';
import type {
  LocalDaemonInteractOptions,
  LocalDaemonRegexDescriptor,
} from '../local-daemon-interact-options.js';
import type { LocalDaemonBuilderState } from './local-daemon-builder-state.js';

/**
 * Normalizes a `RegExp` or pattern string into a frozen `LocalDaemonRegexDescriptor`.
 *
 * Preserves regex flags only when non-empty so passive AST serialization remains canonical.
 *
 * @param {RegExp | string} pattern - Regular expression instance or source string.
 *
 * @returns {LocalDaemonRegexDescriptor} Frozen serializable regex descriptor.
 */
export function normalizeRegexDescriptor(pattern: RegExp | string): LocalDaemonRegexDescriptor {
  if (typeof pattern === 'string') {
    return Object.freeze<LocalDaemonRegexDescriptor>({ pattern, flags: undefined });
  }
  return Object.freeze<LocalDaemonRegexDescriptor>({
    pattern: pattern.source,
    flags: pattern.flags.length > 0 ? pattern.flags : undefined,
  });
}

/**
 * Compiles a `LocalDaemonInteractOptions` entry into a frozen `LocalServiceInteractionConfig`.
 *
 * Applies default `description` (`` `Interact with service via ${toolName}` ``), default
 * `inputSchema` (`z.object({ input: z.string() })`), and normalizes `frameDelimiter`.
 *
 * @template TInput Validated tool input payload type.
 *
 * @param {string}                             toolName - Unique interaction tool name.
 * @param {LocalDaemonInteractOptions<TInput>} options  - Interaction configuration options.
 *
 * @returns {LocalServiceInteractionConfig} Frozen service interaction configuration.
 *
 * @throws {Error} If `toolName` is empty or timing parameters are invalid.
 */
export function compileDaemonInteractionConfig<TInput>(
  toolName: string,
  options: LocalDaemonInteractOptions<TInput>,
): LocalServiceInteractionConfig {
  if (toolName.trim().length === 0) {
    throw new Error('local.daemon.interact requires a non-empty toolName.');
  }
  const frameDelimiter =
    typeof options.frameDelimiter === 'string'
      ? options.frameDelimiter
      : options.frameDelimiter instanceof RegExp
        ? normalizeRegexDescriptor(options.frameDelimiter)
        : Object.freeze<LocalDaemonRegexDescriptor>({
            pattern: options.frameDelimiter.pattern,
            flags: options.frameDelimiter.flags,
          });
  return Object.freeze<LocalServiceInteractionConfig>({
    toolName,
    description: options.description ?? `Interact with service via ${toolName}`,
    inputSchema: options.inputSchema ?? z.object({ input: z.string() }),
    command: options.command,
    frameDelimiter,
    idleSettleMs: options.idleSettleMs,
    timeoutSeconds: options.timeoutSeconds,
  });
}

/**
 * Compiles `LocalDaemonBuilderState` into a deeply frozen `LocalServiceNode`.
 *
 * Validates that `.start(...)` is configured and populates `toolSchemas` up front from all
 * registered `.interact(...)` tools.
 *
 * @param {LocalDaemonBuilderState} state - Current immutable builder state.
 *
 * @returns {LocalServiceNode} Frozen passive service AST node.
 *
 * @throws {Error} If `.start(...)` was not configured on the builder.
 */
export function compileLocalDaemonNode(state: LocalDaemonBuilderState): LocalServiceNode {
  if (state.startArgv === undefined) {
    throw new Error(`local.daemon('${state.id}') requires .start(...) before compilation.`);
  }
  const toolSchemas: ServiceToolSchemaDescriptor[] = [];
  for (const interaction of state.interactions) {
    toolSchemas.push(
      Object.freeze<ServiceToolSchemaDescriptor>({
        name: interaction.toolName,
        description: interaction.description,
        inputSchema: interaction.inputSchema,
      }),
    );
  }
  return Object.freeze<LocalServiceNode>({
    type: 'node:service',
    id: state.id,
    lifecycle: state.lifecycle,
    toolSchemas: Object.freeze(toolSchemas),
    runner: state.runner,
    ports: Object.freeze([...state.ports]),
    startArgv: state.startArgv,
    stopArgv: state.stopArgv,
    readyWhenStdoutRegex: state.readyWhenStdoutRegex,
    interactions: Object.freeze([...state.interactions]),
  });
}
