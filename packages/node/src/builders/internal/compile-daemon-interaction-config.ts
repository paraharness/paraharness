import { z, type LocalServiceInteractionConfig } from '@paraharness/core';
import type {
  LocalDaemonInteractOptions,
  LocalDaemonRegexDescriptor,
} from '../local-daemon-builder.js';
import { normalizeRegexDescriptor } from './normalize-regex-descriptor.js';

/**
 * Normalizes a `frameDelimiter` option (`string | RegExp | LocalDaemonRegexDescriptor`) into a passive AST value.
 *
 * Uses guard clauses to convert `RegExp` instances and clone regex descriptors without nested ternaries.
 *
 * @param {string | RegExp | LocalDaemonRegexDescriptor} delimiter - Raw frame delimiter configuration.
 *
 * @returns {string | LocalDaemonRegexDescriptor} Frozen frame delimiter descriptor.
 */
function normalizeFrameDelimiter(
  delimiter: string | RegExp | LocalDaemonRegexDescriptor,
): string | LocalDaemonRegexDescriptor {
  if (typeof delimiter === 'string') {
    return delimiter;
  }
  if (delimiter instanceof RegExp) {
    return normalizeRegexDescriptor(delimiter);
  }
  return Object.freeze<LocalDaemonRegexDescriptor>({
    pattern: delimiter.pattern,
    flags: delimiter.flags,
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
 * @throws {Error} If `toolName` is empty or whitespace-only.
 */
export function compileDaemonInteractionConfig<TInput>(
  toolName: string,
  options: LocalDaemonInteractOptions<TInput>,
): LocalServiceInteractionConfig {
  if (toolName.trim().length === 0) {
    throw new Error('local.daemon.interact requires a non-empty toolName.');
  }
  return Object.freeze<LocalServiceInteractionConfig>({
    toolName,
    description: options.description ?? `Interact with service via ${toolName}`,
    inputSchema: options.inputSchema ?? z.object({ input: z.string() }),
    command: options.command,
    frameDelimiter: normalizeFrameDelimiter(options.frameDelimiter),
    idleSettleMs: options.idleSettleMs,
    timeoutSeconds: options.timeoutSeconds,
  });
}
