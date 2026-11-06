import type { ToolEffect } from '../../ports/tool-effect.js';
import type { ToolExecutionResult } from '../../ports/tool-execution-result.js';
import type { PolicyEvaluationResult } from './policy-evaluation-result.js';

/**
 * Outcome returned by `executePostFlightSandboxedTool()` after running a `'subprocess-post-flight'` tool (`SPEC.md` §3.5).
 *
 * Reports whether the subprocess succeeded and passed post-flight `diffEffects` guards, or was rolled back
 * to `inFlightPreToolCheckpoint` due to a throw/abort, `'deny-with-error'`, or `'raise-interrupt'`.
 */
export interface PostFlightSandboxResult {
  /** Post-flight execution and verification outcome status. */
  readonly status: 'allowed' | 'rolled-back-error' | 'rolled-back-interrupt';
  /** Tool execution result (or synthesized rollback error result) to append to `completedResults`. */
  readonly toolResult: ToolExecutionResult;
  /** Synthesized post-flight `ToolEffect` list from `scope.diffEffects()`. */
  readonly synthesizedEffects: readonly ToolEffect[];
  /** Policy guard evaluation result when rolled back due to a guard violation. */
  readonly policyResult?: PolicyEvaluationResult;
}
