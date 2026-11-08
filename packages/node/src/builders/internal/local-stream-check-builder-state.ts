import type {
  EnvRef,
  LocalStreamCheckCircuitBreakerConfig,
  NodeRunnerNode,
} from '@paraharness/core';

/**
 * Immutable internal state snapshot backing `LocalStreamCheckBuilder`.
 *
 * Stores configured runner pool, `argv`, environment bindings, timeout, and circuit-breaker rule.
 */
export interface LocalStreamCheckBuilderState {
  /** Unique identifier of the streaming check. */
  readonly id: string;
  /** Bound runner pool AST node. */
  readonly runner: NodeRunnerNode;
  /** Configured command argument vector. */
  readonly argv?: readonly string[];
  /** Optional environment variable map. */
  readonly env?: Readonly<Record<string, string | EnvRef>>;
  /** Optional execution timeout in minutes. */
  readonly timeoutMinutes?: number;
  /** Optional rolling-window circuit-breaker configuration. */
  readonly circuitBreaker?: LocalStreamCheckCircuitBreakerConfig;
}
