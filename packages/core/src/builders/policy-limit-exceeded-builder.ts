import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AbortHookASTNode } from '../ast/domain-ast.types.js';
import type { InterruptNode } from '../ast/interrupt-node.js';
import type { PolicyLimitExceededConfig } from '../ast/policy-node.js';

/**
 * Fluent configurator passed to `H.policy(id).onLimitExceeded(($limit) => ...)`.
 *
 * Configures the epistemic flush interrupt and optional abort hook executed when a
 * quantitative policy ceiling (`maxTurns`, `maxCostUsd`, `maxDurationSeconds`, or tripwire) trips.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PolicyLimitExceededBuilder<THandle = unknown> {
  /**
   * Binds the `InterruptNode` flushed via a `toolChoice: 'none'` structured-output turn when a limit trips.
   *
   * Required before `.build()` can compile a valid `PolicyLimitExceededConfig`.
   *
   * @param {MaybeBuilder<InterruptNode<unknown>>} interrupt - Target interrupt node or builder.
   *
   * @returns {PolicyLimitExceededBuilder<THandle>} New immutable limit-exceeded builder.
   */
  flushWithInterrupt(
    interrupt: MaybeBuilder<InterruptNode<unknown>>,
  ): PolicyLimitExceededBuilder<THandle>;

  /**
   * Binds the `AbortHookASTNode` executed after the epistemic flush turn completes.
   *
   * Used on Tier-1 `'scope'` environments or when custom git snapshot cleanup is required.
   *
   * @param {MaybeBuilder<AbortHookASTNode<THandle, Record<string, unknown>>>} hook - Abort hook AST node or builder.
   *
   * @returns {PolicyLimitExceededBuilder<THandle>} New immutable limit-exceeded builder.
   */
  onAbort(
    hook: MaybeBuilder<AbortHookASTNode<THandle, Record<string, unknown>>>,
  ): PolicyLimitExceededBuilder<THandle>;

  /**
   * Compiles and returns the frozen `PolicyLimitExceededConfig<THandle>`.
   *
   * Validates that `.flushWithInterrupt(interrupt)` has been configured before freezing.
   *
   * @returns {PolicyLimitExceededConfig<THandle>} Deeply frozen limit-exceeded configuration.
   */
  build(): PolicyLimitExceededConfig<THandle>;
}
