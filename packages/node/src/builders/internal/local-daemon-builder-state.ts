import type {
  LocalServiceInteractionConfig,
  NodeRunnerNode,
} from '@paraharness/core';
import type {
  LocalDaemonCommandContext,
  LocalDaemonRegexDescriptor,
} from '../local-daemon-builder.js';

/**
 * Immutable internal state snapshot backing `LocalDaemonBuilder`.
 *
 * Captures runner pool, lifecycle mode, declared port names, start/stop command factories,
 * readiness regex descriptor, and registered PTY interaction tools.
 */
export interface LocalDaemonBuilderState {
  /** Unique identifier of the daemon service. */
  readonly id: string;
  /** Bound runner pool AST node. */
  readonly runner: NodeRunnerNode;
  /** Service lifecycle binding mode. */
  readonly lifecycle: 'scope' | 'fork' | 'skill';
  /** Declared dynamic port names in registration order. */
  readonly ports: readonly string[];
  /** Startup command `argv` factory. */
  readonly startArgv?: (ctx: LocalDaemonCommandContext) => readonly string[];
  /** Optional stop/cleanup command `argv` factory. */
  readonly stopArgv?: (ctx: LocalDaemonCommandContext) => readonly string[];
  /** Optional readiness regex descriptor over combined `stdout`/`stderr`. */
  readonly readyWhenStdoutRegex?: LocalDaemonRegexDescriptor;
  /** Registered PTY interaction tool configurations. */
  readonly interactions: readonly LocalServiceInteractionConfig[];
}
