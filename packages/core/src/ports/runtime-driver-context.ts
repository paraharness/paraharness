import type { RunnerPoolASTNode } from '../ast/domain-ast.types.js';
import type { EnvRef } from '../ast/env-ref.js';
import type { RunnerDriver } from './runner-driver.js';
import type { RuntimeExecutorRegistry } from './runtime-executor-registry.js';

/**
 * Root runtime driver context supplied to adapter factory functions in `RuntimeExecutorRegistry`.
 *
 * Provides access to the composite executor registry, symbolic `EnvRef` resolution, and memoized
 * `RunnerDriver` instances keyed by runner node ID.
 */
export interface RuntimeDriverContext {
  /** Composite registry of stateless AST node executors and driver factories. */
  readonly registry: RuntimeExecutorRegistry;

  /**
   * Resolves a literal string or symbolic `H.env(key)` reference against the runtime environment map.
   *
   * Evaluates symbolic environment references strictly at leaf driver invocation time without reading `process.env` directly.
   *
   * @param {string | EnvRef} value - Literal string or symbolic environment variable reference.
   *
   * @returns {string | undefined} Resolved environment variable value, or `undefined` if unset.
   */
  resolveEnv(value: string | EnvRef): string | undefined;

  /**
   * Returns the runtime's memoized `RunnerDriver` instance for the given runner pool AST node.
   *
   * Ensures all steps and services referencing the same `RunnerPoolASTNode.id` share a single concurrency semaphore.
   *
   * @param {RunnerPoolASTNode} node - Passive runner pool AST node.
   *
   * @returns {RunnerDriver} Memoized concurrency-limiting runner driver instance.
   */
  getRunner(node: RunnerPoolASTNode): RunnerDriver;
}
