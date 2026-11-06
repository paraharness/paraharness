import type { HarnessExecutionEngine } from '../../ports/harness-execution-engine.js';
import { createRuntime } from './create-runtime.js';

/**
 * Default `HarnessExecutionEngine` singleton delegating directly to `createRuntime()` (`SPEC.md` §3.1).
 *
 * Used by `H.harness(...).compile()` and runtime callers when no custom execution engine is supplied.
 */
export const defaultExecutionEngine: HarnessExecutionEngine = Object.freeze<HarnessExecutionEngine>({
  createRuntime,
});
