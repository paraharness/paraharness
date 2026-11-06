import type { RuntimeExecutorRegistry } from './runtime-executor-registry.js';

/**
 * Partial slice of `RuntimeExecutorRegistry` exported by an individual domain adapter package.
 *
 * Allows each `@harness-dsl/*` adapter package to register only its own AST node executors
 * and combine them via `createExecutorRegistry(...slices)`.
 */
export type RuntimeExecutorRegistrySlice = {
  readonly [K in keyof RuntimeExecutorRegistry]?: Partial<RuntimeExecutorRegistry[K]>;
};
