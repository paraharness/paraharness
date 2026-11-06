import type { BaseCheckASTNode } from '../base/base-check-ast-node.js';
import type { BaseDomainStepASTNode } from '../base/base-domain-step-ast-node.js';
import type { EnvRef } from '../env-ref.js';
import type { NodeRunnerNode } from './node-runner-node.js';

/**
 * Rolling-window regex circuit-breaker configuration over combined `stdout` and `stderr` for `LocalStreamCheckNode`.
 *
 * Terminates the streaming subprocess early once `pattern` matches and `graceLinesAfterMatch` trailing lines are captured.
 */
export interface LocalStreamCheckCircuitBreakerConfig {
  /** Regular expression source pattern that triggers early termination on match. */
  readonly pattern: string;
  /** Optional regular expression flags. */
  readonly flags?: string;
  /** Number of trailing output lines to capture after a circuit-breaker match before killing the process. */
  readonly graceLinesAfterMatch: number;
}

/**
 * Passive AST node representing a streaming subprocess check with rolling-window regex circuit-breaking (`local.streamCheck`).
 *
 * Participates in both `CheckASTNode` and `StepASTNode`.
 *
 * @template THandle Isolation scope handle type.
 */
export interface LocalStreamCheckNode<THandle = unknown>
  extends BaseCheckASTNode<'node:stream-check', THandle>,
    BaseDomainStepASTNode<
      'node:stream-check',
      unknown,
      { readonly ok: boolean; readonly deficits: readonly string[] },
      THandle
    > {
  /** Runner pool governing subprocess slot concurrency. */
  readonly runner: NodeRunnerNode;
  /** Command argument vector executed by the streaming check. */
  readonly argv: readonly string[];
  /** Optional environment variables or symbolic `EnvRef` bindings. */
  readonly env?: Readonly<Record<string, string | EnvRef>>;
  /** Optional execution timeout in minutes. */
  readonly timeoutMinutes?: number;
  /** Optional rolling-window regex circuit-breaker over combined `stdout` and `stderr`. */
  readonly circuitBreaker?: LocalStreamCheckCircuitBreakerConfig;
}
