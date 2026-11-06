import type { ToolASTNode } from '../../ast/domain-ast.types.js';
import type { PolicyNode } from '../../ast/policy-node.js';
import type { LeaseDelta } from '../../ports/lease-delta.js';
import type { RemainingToolCallRecord } from '../../ports/pending-tool-batch.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';

/**
 * Parameters for evaluating pre-flight policy guards across a pending tool call batch `(i..k)`.
 *
 * Supplies the active `PolicyNode`, remaining tool calls starting at index `i`, registered tool nodes,
 * active capability leases, and step execution context.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PreFlightBatchEvalParams<THandle = unknown> {
  /** Active policy AST node governing tool execution, or `undefined` when unguarded. */
  readonly policy: PolicyNode<THandle> | undefined;
  /** Unfinished tool calls `(i..k)` starting with the currently inspected call at index `0`. */
  readonly remainingCalls: readonly RemainingToolCallRecord[];
  /** Map of tool name to passive `ToolASTNode` mounted on the actor or unlocked by active skills. */
  readonly toolsByName: ReadonlyMap<string, ToolASTNode<THandle>>;
  /** Active capability leases (`agent-frame.activeLeases` unioned with `loop-frame.grantedLoopLeases`). */
  readonly activeLeases: readonly LeaseDelta[];
  /** Step execution context providing `scopeHandle` and `registry`. */
  readonly ctx: StepExecutionContext<THandle>;
}
