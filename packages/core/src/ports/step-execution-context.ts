import type { ExecutionContext } from './execution-context.js';
import type { RuntimeExecutorRegistry } from './runtime-executor-registry.js';

/**
 * Extended step execution context combining `ExecutionContext<THandle>` with `RuntimeExecutorRegistry`.
 *
 * Supplied to step executors, tool drivers, checks, policy guards, tripwires, and hooks so they can
 * dispatch nested AST nodes via `ctx.registry`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface StepExecutionContext<THandle = unknown> extends ExecutionContext<THandle> {
  /** Composite registry of stateless AST node executors and driver factories. */
  readonly registry: RuntimeExecutorRegistry;
}
