import type { RuntimeExecutorRegistry } from './runtime-executor-registry.js';
import type { RuntimeExecutorRegistrySlice } from './runtime-executor-registry-slice.js';

/**
 * Configuration options supplied when instantiating a `HarnessRuntime` via `createRuntime(harness, options)`.
 *
 * Injects the concrete `RuntimeExecutorRegistry` (or adapter slice) and explicit environment variable map
 * used to resolve symbolic `H.env(key)` references at leaf driver invocation time.
 */
export interface HarnessRuntimeOptions {
  /** Executor registry or partial registry slice mapping domain AST node types to runtime drivers. */
  readonly registry?: Partial<RuntimeExecutorRegistry> | RuntimeExecutorRegistrySlice;
  /** Explicit environment variable map used to resolve symbolic `H.env(key)` references. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}
