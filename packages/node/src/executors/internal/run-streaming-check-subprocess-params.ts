import type { LocalStreamCheckCircuitBreakerConfig } from '@harness-dsl/core';
import type { ResolvedSubprocessEnvironment } from './spawn-detached-subprocess-params.js';

/**
 * Parameters for executing a streaming verification check subprocess via `runStreamingCheckSubprocess`.
 *
 * Supplies the check identifier, argument vector, resolved environment, optional rolling-window
 * regex circuit breaker, timeout duration, and abort signal.
 */
export interface RunStreamingCheckSubprocessParams {
  /** Logical identifier of the streaming check. */
  readonly checkId: string;
  /** Command argument vector where index `0` is the executable. */
  readonly argv: readonly string[];
  /** Resolved working directory and environment variables. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
  /** Optional rolling-window regex circuit-breaker configuration. */
  readonly circuitBreaker?: LocalStreamCheckCircuitBreakerConfig;
  /** Optional execution timeout in minutes. */
  readonly timeoutMinutes?: number;
  /** Optional abort signal cancelling subprocess execution. */
  readonly signal?: AbortSignal;
}
