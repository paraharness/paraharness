import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { StepRuntimeInternals } from '../step-runtime-internals.js';

/**
 * Extracts the optional `StepRuntimeInternals` bag attached to `ctx` (`SPEC.md` §3.1–§3.10).
 *
 * Centralizes access to internal runtime stores, lock managers, and continuation sinks without
 * repeating inline structural casts across executors (`Rule 5.1`).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {StepExecutionContext<THandle>} ctx - Active step execution context.
 *
 * @returns {StepRuntimeInternals<THandle> | undefined} Attached runtime internals, if present.
 */
export function getStepRuntimeInternals<THandle = unknown>(
  ctx: StepExecutionContext<THandle>,
): StepRuntimeInternals<THandle> | undefined {
  return (ctx as StepExecutionContext<THandle> & { readonly _runtime?: StepRuntimeInternals<THandle> })
    ._runtime;
}
