import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type {
  AbortHookASTNode,
  PolicyGuardASTNode,
  QuotaTripwireASTNode,
} from '../ast/domain-ast.types.js';
import type { InterruptNode } from '../ast/interrupt-node.js';
import type { PolicyLimitExceededConfig, PolicyNode } from '../ast/policy-node.js';
import type { PolicyViolation } from '../ast/policy-violation.js';

/**
 * Fluent configurator for limit-exceeded flush and abort handling (`$limit` in `.onLimitExceeded`).
 *
 * Configures the mandatory flush interrupt and optional abort hook invoked when
 * `maxTurns`, `maxCostUsd`, or `maxDurationSeconds` is breached.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PolicyLimitExceededBuilder<THandle = unknown> {
  /**
   * Binds the mandatory interrupt raised after flushing the in-flight turn on a limit breach.
   *
   * Enables downstream `.onInterrupt(interrupt, ...)` edges to adjudicate, ask, or replace the actor.
   *
   * @template TPayload Interrupt payload type.
   *
   * @param {MaybeBuilder<InterruptNode<TPayload>>} interrupt - Target interrupt AST node or builder.
   *
   * @returns {PolicyLimitExceededBuilder<THandle>} Updated immutable builder instance.
   */
  flushWithInterrupt<TPayload = unknown>(
    interrupt: MaybeBuilder<InterruptNode<TPayload>>,
  ): PolicyLimitExceededBuilder<THandle>;

  /**
   * Binds an optional abort hook (`git.snapshotAndReset()`) executed before raising the flush interrupt.
   *
   * Captures abort metadata into `telemetry.abortMeta` for downstream replacement steps.
   *
   * @template TAbortMeta Structured metadata record returned by the abort hook.
   *
   * @param {MaybeBuilder<AbortHookASTNode<THandle, TAbortMeta>>} abortHook - Abort hook AST node or builder.
   *
   * @returns {PolicyLimitExceededBuilder<THandle>} Updated immutable builder instance.
   */
  onAbort<TAbortMeta extends Record<string, unknown> = Record<string, unknown>>(
    abortHook: MaybeBuilder<AbortHookASTNode<THandle, TAbortMeta>>,
  ): PolicyLimitExceededBuilder<THandle>;

  /**
   * Compiles the accumulated limit-exceeded state into an immutable `PolicyLimitExceededConfig`.
   *
   * Internal finalize method invoked by `PolicyBuilder.onLimitExceeded`.
   *
   * @returns {PolicyLimitExceededConfig<THandle>} Deeply frozen limit-exceeded configuration.
   */
  build(): PolicyLimitExceededConfig<THandle>;
}

/**
 * Intermediate fluent builder returned by `H.policy(id).guard(...guards)` requiring `.onViolation(...)`.
 *
 * Forces callers to explicitly bind either `'deny-with-error'` or `'raise-interrupt'`
 * for every registered guard clause before returning to `PolicyBuilder`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PolicyGuardClauseBuilder<THandle = unknown> {
  /**
   * Rejects violating tool calls in-band and returns a structured error string to the model.
   *
   * When `messageMapper` is omitted, the runtime injects `violation.violationSummary` into the tool error result.
   *
   * @param {'deny-with-error'}                      mode            - In-band error rejection mode.
   * @param {(violation: PolicyViolation) => string} [messageMapper] - Optional custom error formatter.
   *
   * @returns {PolicyBuilder<THandle>} Parent `PolicyBuilder` with the guard clause appended.
   */
  onViolation(
    mode: 'deny-with-error',
    messageMapper?: (violation: PolicyViolation) => string,
  ): PolicyBuilder<THandle>;

  /**
   * Halts the offending tool batch and raises a typed `InterruptNode` into the active interrupt hierarchy.
   *
   * Maps the `PolicyViolation` into `TPayload` via `mapViolation` and validates it against `interrupt.schema`.
   *
   * @template TPayload Interrupt payload type validated by `interrupt.schema`.
   *
   * @param {'raise-interrupt'}                        mode         - Interrupt escalation mode.
   * @param {MaybeBuilder<InterruptNode<TPayload>>}    interrupt    - Target interrupt AST node or builder.
   * @param {(violation: PolicyViolation) => TPayload} mapViolation - Violation-to-payload projector.
   *
   * @returns {PolicyBuilder<THandle>} Parent `PolicyBuilder` with the guard clause appended.
   */
  onViolation<TPayload>(
    mode: 'raise-interrupt',
    interrupt: MaybeBuilder<InterruptNode<TPayload>>,
    mapViolation: (violation: PolicyViolation) => TPayload,
  ): PolicyBuilder<THandle>;
}

/**
 * Fluent builder for capability and sandbox policies (`H.policy(id)`).
 *
 * Aggregates ordered guard clauses (`fs.protect`, `fs.readOnly`, `node.allowBinaries`),
 * quota tripwires (`fs.quotaTripwire`), quantitative turn/cost/duration limits, and `.extend(newId)`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PolicyBuilder<THandle = unknown> extends AstBuilder<PolicyNode<THandle>> {
  /** Unique identifier of the policy. */
  readonly id: string;

  /**
   * Starts a new guard clause inspecting pre-flight or post-flight `ToolEffect` lists.
   *
   * Returns a `PolicyGuardClauseBuilder` requiring `.onViolation(...)` to complete the clause.
   *
   * @param {...ReadonlyArray<MaybeBuilder<PolicyGuardASTNode>>} guards - Guard AST nodes or builders.
   *
   * @returns {PolicyGuardClauseBuilder<THandle>} Pending clause builder requiring `.onViolation(...)`.
   */
  guard(
    ...guards: ReadonlyArray<MaybeBuilder<PolicyGuardASTNode>>
  ): PolicyGuardClauseBuilder<THandle>;

  /**
   * Appends stateful `QuotaTripwireASTNode` monitors (`fs.quotaTripwire`) evaluated across cumulative effects.
   *
   * Tripwires raise their configured interrupt when cumulative workspace mutations exceed thresholds.
   *
   * @param {...ReadonlyArray<MaybeBuilder<QuotaTripwireASTNode>>} tripwires - Quota tripwire AST nodes or builders.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder.
   */
  tripwire(
    ...tripwires: ReadonlyArray<MaybeBuilder<QuotaTripwireASTNode>>
  ): PolicyBuilder<THandle>;

  /**
   * Sets the maximum number of model turns allowed per actor execution under this policy.
   *
   * Breaching `turns` triggers `onLimitExceeded` (if configured) or terminates the step.
   *
   * @param {number} turns - Positive integer turn ceiling.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder.
   */
  maxTurns(turns: number): PolicyBuilder<THandle>;

  /**
   * Sets the maximum cumulative USD cost allowed per actor execution under this policy.
   *
   * Breaching `costUsd` triggers `onLimitExceeded` (if configured) or terminates the step.
   *
   * @param {number} costUsd - Positive USD cost ceiling.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder.
   */
  maxCostUsd(costUsd: number): PolicyBuilder<THandle>;

  /**
   * Sets the maximum wall-clock duration in seconds allowed per actor execution under this policy.
   *
   * Breaching `seconds` triggers `onLimitExceeded` (if configured) or terminates the step.
   *
   * @param {number} seconds - Positive duration ceiling in seconds.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder.
   */
  maxDurationSeconds(seconds: number): PolicyBuilder<THandle>;

  /**
   * Binds a policy-level default abort hook (`git.snapshotAndReset()`) for unhooked `.replaceWith()` edges.
   *
   * Satisfies Tier-1 `'scope'` replacement requirements when a step's `.replaceWith()` omits `.onAbort()`.
   *
   * @param {MaybeBuilder<AbortHookASTNode<THandle, Record<string, unknown>>>} abortHook - Abort hook AST node or builder.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder.
   */
  onAbort(
    abortHook: MaybeBuilder<AbortHookASTNode<THandle, Record<string, unknown>>>,
  ): PolicyBuilder<THandle>;

  /**
   * Configures the limit-exceeded flush interrupt and optional abort hook when a quantitative limit is reached.
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
   * Clones this policy under `newId`, inheriting all existing clauses, tripwires, limits, and hooks.
   *
   * Re-keys inherited guard clause IDs deterministically as `"${newId}:clause:${i}"`.
   *
   * @param {string} newId - Unique identifier for the derived policy.
   *
   * @returns {PolicyBuilder<THandle>} New immutable policy builder initialized with inherited state.
   */
  extend(newId: string): PolicyBuilder<THandle>;
}
