import type { ToolASTNode } from '../../ast/domain-ast.types.js';
import type { PolicyNode } from '../../ast/policy-node.js';
import type { CheckpointableScope } from '../../ports/checkpointable-scope.js';
import type { LeaseDelta } from '../../ports/lease-delta.js';
import type { RemainingToolCallRecord } from '../../ports/pending-tool-batch.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { ToolDriver } from '../../ports/tool-driver.js';
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

/**
 * Parameters for executing a tool with `effectTracking === 'subprocess-post-flight'` (`SPEC.md` §3.5).
 *
 * Supplies the tool node, driver, call record, parsed arguments, `CheckpointableScope`, active policy,
 * capability leases, and a persistence callback for `inFlightPreToolCheckpoint`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PostFlightSandboxParams<THandle = unknown> {
  /** Passive tool AST node with `effectTracking === 'subprocess-post-flight'`. */
  readonly toolNode: ToolASTNode<THandle>;
  /** Registered `ToolDriver` for `toolNode.type`. */
  readonly toolDriver: ToolDriver<ToolASTNode<THandle>, THandle>;
  /** Wire-level tool call record being executed. */
  readonly callRecord: RemainingToolCallRecord;
  /** Parsed JSON arguments passed to `toolDriver.execute()`. */
  readonly parsedArgs: unknown;
  /** Active `CheckpointableScope` driver supporting `serializeCheckpoint`, `restoreCheckpoint`, and `diffEffects`. */
  readonly checkpointScope: CheckpointableScope<THandle, Record<string, unknown>>;
  /** Optional `PolicyNode` evaluated post-flight over `diffEffects`. */
  readonly policy: PolicyNode<THandle> | undefined;
  /** Active capability leases (`agent-frame.activeLeases` unioned with `loop-frame.grantedLoopLeases`). */
  readonly activeLeases: readonly LeaseDelta[];
  /** Step execution context providing `scopeHandle`, `registry`, and `recordEffects`. */
  readonly ctx: StepExecutionContext<THandle>;
  /** Async callback that durably persists or clears `inFlightPreToolCheckpoint` in `LedgerStore` before/after execution. */
  readonly persistInFlightCheckpoint: (checkpoint: string | undefined) => Promise<void>;
  /** Optional reference to result shape for property reachability. */
  readonly resultTemplate?: PostFlightSandboxResult;
}
