import type { ScopeRewindHookASTNode } from '../../ast/domain-ast.types.js';
import type { FlowExecutionContext } from './flow-execution-context.js';

/**
 * Parameters for executing the 4-step Hierarchical Rewind Drain Barrier (`SPEC.md` §3.10).
 *
 * Supplies the flow execution context, target `rewindToStepId`, updated flow input, and optional
 * `onRewind` scope hook.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface HierarchicalRewindDrainParams<TIn = unknown, THandle = unknown> {
  /** Active flow execution context. */
  readonly flowCtx: FlowExecutionContext<TIn, THandle>;
  /** Target step or branch ID in `flow.nodes` to rewind execution to (or `null` when cancelling). */
  readonly rewindToStepId: string | null;
  /** Updated flow input payload produced by `onSignal.updateMapper`. */
  readonly updatedInput: TIn;
  /** Optional scope rewind hook executed during Step 4 of the drain barrier. */
  readonly onRewindHook?: ScopeRewindHookASTNode<THandle>;
  /** Terminal status recorded on the interrupted active step (`'INTERRUPTED'` or `'CANCELLED'`). */
  readonly stepTerminalStatus?: 'INTERRUPTED' | 'CANCELLED';
}
