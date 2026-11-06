/**
 * Configuration options for a rolling-window regex circuit breaker on `local.streamCheck`.
 *
 * Specifies how many trailing lines of output to capture after the circuit-breaker regex matches
 * before terminating the streaming subprocess group.
 */
export interface LocalStreamCheckCircuitBreakerOptions {
  /** Number of additional output lines to collect after a circuit-breaker regex match. */
  readonly graceLinesAfterMatch: number;
}
