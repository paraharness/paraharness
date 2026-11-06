import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type {
  AbortHookASTNode,
  PolicyGuardASTNode,
  QuotaTripwireASTNode,
} from '../ast/domain-ast.types.js';
import type { PolicyNode } from '../ast/policy-node.js';
import type { PolicyGuardClauseBuilder } from './policy-guard-clause-builder.js';
import type { PolicyLimitExceededBuilder } from './policy-limit-exceeded-builder.js';

/**
 * Fluent builder for capability and sandbox policies (`H.policy(id)`).
 *
 * Aggregates ordered `PolicyGuardClauseNode` entries, post-flight `QuotaTripwireASTNode`
 * monitors, quantitative resource ceilings, default abort hooks, and limit-exceeded handlers.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PolicyBuilder<THandle = unknown> extends AstBuilder<PolicyNode<THandle>> {
  /** Unique identifier of the policy. */
  readonly id: string;

  /**
   * Starts a new guard clause over one or more `PolicyGuardASTNode` descriptors, completed via `.onViolation(...)`.
   *
   * Assigns a deterministic clause identifier `"${policyId}:clause:${clauseIndex}"` in declaration order.
   *
   * @param {...ReadonlyArray<MaybeBuilder<PolicyGuardASTNode>>} guards - Policy guard AST nodes or builders.
   *
   * @returns {PolicyGuardClauseBuilder<THandle>} Pending clause builder requiring `.onViolation(...)`.
   */
  guard(
    ...guards: ReadonlyArray<MaybeBuilder<PolicyGuardASTNode>>
  ): PolicyGuardClauseBuilder<THandle>;

  /**
   * Appends one or more domain quota tripwires (`QuotaTripwireASTNode`) evaluated post-flight after each tool call.
   *
   * Breaching any tripwire triggers the policy's `.onLimitExceeded(...)` handler.
   *
   * @param {...ReadonlyArray<MaybeBuilder<QuotaTripwireASTNode>>} tripwires - Quota tripwire AST nodes or builders.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder.
   */
  tripwire(...tripwires: ReadonlyArray<MaybeBuilder<QuotaTripwireASTNode>>): PolicyBuilder<THandle>;

  /**
   * Sets the maximum number of LLM generation turns allowed before tripping `onLimitExceeded`.
   *
   * Enforces an upper bound on model turn invocations within a single step execution.
   *
   * @param {number} turns - Positive integer turn ceiling.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder.
   */
  maxTurns(turns: number): PolicyBuilder<THandle>;

  /**
   * Sets the maximum cumulative USD cost allowed before tripping `onLimitExceeded`.
   *
   * Enforces an upper bound on model token and tool execution spend within a step.
   *
   * @param {number} costUsd - Positive USD cost ceiling.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder.
   */
  maxCostUsd(costUsd: number): PolicyBuilder<THandle>;

  /**
   * Sets the maximum cumulative wall-clock duration in seconds allowed before tripping `onLimitExceeded`.
   *
   * Enforces a wall-clock timeout before triggering epistemic flush and abort.
   *
   * @param {number} seconds - Positive duration ceiling in seconds.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder.
   */
  maxDurationSeconds(seconds: number): PolicyBuilder<THandle>;

  /**
   * Binds a default `AbortHookASTNode` executed when the governed step is aborted or replaced.
   *
   * Satisfies the Tier-1 `'scope'` abort-hook requirement for `.replaceWith()` interrupt edges.
   *
   * @param {MaybeBuilder<AbortHookASTNode<THandle, Record<string, unknown>>>} hook - Abort hook AST node or builder.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder.
   */
  onAbort(
    hook: MaybeBuilder<AbortHookASTNode<THandle, Record<string, unknown>>>,
  ): PolicyBuilder<THandle>;

  /**
   * Configures the epistemic flush turn and abort hook executed when any quantitative limit or tripwire is breached.
   *
   * Invokes `configure` with a `PolicyLimitExceededBuilder` and stores the compiled config.
   *
   * @param {($limit: PolicyLimitExceededBuilder<THandle>) => PolicyLimitExceededBuilder<THandle>} configure - Limit-exceeded configurator callback.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder.
   */
  onLimitExceeded(
    configure: ($limit: PolicyLimitExceededBuilder<THandle>) => PolicyLimitExceededBuilder<THandle>,
  ): PolicyBuilder<THandle>;

  /**
   * Creates a derived `PolicyBuilder` with `newId` inheriting all guard clauses, tripwires, limits, and hooks from this policy.
   *
   * Re-keys inherited guard clause identifiers to `"${newId}:clause:${i}"` while preserving evaluation order.
   *
   * @param {string} newId - Non-empty identifier for the derived policy.
   *
   * @returns {PolicyBuilder<THandle>} Derived immutable policy builder.
   */
  extend(newId: string): PolicyBuilder<THandle>;
}
