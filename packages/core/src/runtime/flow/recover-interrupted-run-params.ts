import type { FlowNode } from '../../ast/flow-node.js';
import type { InterruptedStepBootRecord } from '../../ports/interrupted-step-boot-record.js';
import type { FlowExecutionContext } from './flow-execution-context.js';

/**
 * Parameters for recovering a non-terminal run returned by `LedgerStore.getInterruptedStepsOnBoot()` (`SPEC.md` §3.10).
 *
 * Supplies the boot record, bound `FlowNode`, and runtime stores/managers needed to reattach
 * root and child scopes and resume mid-step state machines.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface RecoverInterruptedRunParams<TIn = unknown, THandle = unknown> {
  /** Non-terminal step boot record loaded from `LedgerStore.getInterruptedStepsOnBoot()`. */
  readonly bootRecord: InterruptedStepBootRecord;
  /** Bound `FlowNode` definition for the run's lane. */
  readonly flow: FlowNode<TIn, THandle>;
  /** Active flow execution context configured for the recovered run. */
  readonly flowCtx: FlowExecutionContext<TIn, THandle>;
}
