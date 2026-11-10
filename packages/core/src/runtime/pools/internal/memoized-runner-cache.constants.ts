import type { RunnerPoolASTNode } from '../../../ast/domain-ast.types.js';
import type { RunnerDriver } from '../../../ports/runner-driver.js';
import type { RuntimeExecutorRegistry } from '../../../ports/runtime-executor-registry.js';

/**
 * WeakMap cache of memoized `RunnerDriver` instances and their canonical `RunnerPoolASTNode` specifications keyed by `RuntimeExecutorRegistry` reference (`SPEC.md` §3.5.3).
 */
export const MEMOIZED_RUNNERS_BY_REGISTRY: WeakMap<
  RuntimeExecutorRegistry,
  Map<string, { readonly node: RunnerPoolASTNode; driver: RunnerDriver | undefined }>
> = new WeakMap<
  RuntimeExecutorRegistry,
  Map<string, { readonly node: RunnerPoolASTNode; driver: RunnerDriver | undefined }>
>();
