import type { LocalDaemonRegexDescriptor } from '../../builders/local-daemon-interact-options.js';
import type { ResolvedSubprocessEnvironment } from './spawn-detached-subprocess-params.js';

/**
 * Configuration options for initializing a `PtyFramedInteractiveSession`.
 *
 * Supplies the tool name, interactive CLI `argv`, resolved environment, frame delimiter,
 * output settle quiet window, and per-turn timeout.
 */
export interface PtyFramedSessionOptions {
  /** Unique interaction tool name for diagnostic messages. */
  readonly toolName: string;
  /** Command argument vector spawned inside the `ECHO`-disabled wrapper. */
  readonly argv: readonly string[];
  /** Resolved working directory and environment variables. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
  /** Prompt delimiter string or regex descriptor marking the end of each output frame. */
  readonly frameDelimiter: string | LocalDaemonRegexDescriptor;
  /** Quiet window in milliseconds after `frameDelimiter` matches before settling a frame. */
  readonly idleSettleMs: number;
  /** Maximum timeout in seconds for draining the startup banner or completing a turn. */
  readonly timeoutSeconds: number;
}
