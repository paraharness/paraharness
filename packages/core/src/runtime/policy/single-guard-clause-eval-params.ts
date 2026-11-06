import type { LeaseDelta } from '../../ports/lease-delta.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { ToolEffect } from '../../ports/tool-effect.js';

/**
 * Parameters for evaluating a single policy guard clause against proposed tool effects.
 *
 * Supplies the tool name, proposed effects, active capability leases, and step execution context.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface SingleGuardClauseEvalParams<THandle = unknown> {
  /** Wire-level name of the tool being evaluated. */
  readonly toolName: string;
  /** Proposed pre-flight or post-flight tool effects. */
  readonly proposedEffects: readonly ToolEffect[];
  /** Active capability leases (`agent-frame.activeLeases` unioned with `loop-frame.grantedLoopLeases`). */
  readonly activeLeases: readonly LeaseDelta[];
  /** Step execution context providing `registry.policyGuards` and `registry.effectMatchers`. */
  readonly ctx: StepExecutionContext<THandle>;
}
