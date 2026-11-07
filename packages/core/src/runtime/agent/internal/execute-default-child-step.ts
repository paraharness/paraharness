import type { AgentNode } from '../../../ast/agent-node.js';
import type { StepASTNode } from '../../../ast/domain-ast.types.js';
import type { LoopNode } from '../../../ast/loop-node.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { LessonOutcome } from '../../../ports/lesson-outcome.types.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { ChildForkExecutionOutcome } from '../../fork/child-fork-execution-outcome.js';
import { executeLoop } from '../../loop/execute-loop.js';
import { executeStepNode } from '../../step/execute-step-node.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import { executeAgent } from '../execute-agent.js';
import { getStepRuntimeInternals } from './get-step-runtime-internals.js';

/**
 * Context parameters for `executeDefaultChildStep`.
 *
 * @template TIn     Parent agent input payload type.
 * @template TOut    Parent agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface ExecuteDefaultChildStepContextParams<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
> {
  /** Child step execution context. */
  readonly childCtx: StepExecutionContext<THandle>;
  /** Enclosing parent agent turn session state. */
  readonly parent: AgentTurnSessionState<TIn, TOut, THandle>;
}

/**
 * Default child step runner dispatching `AgentNode`, `LoopNode`, or domain `StepASTNode` instances and capturing upward interrupts (`SPEC.md` §3.7.2).
 *
 * Propagates shared stores, managers, and continuation stacks between parent and child executions.
 *
 * @template TIn     Parent agent input payload type.
 * @template TOut    Parent agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {StepASTNode<unknown, unknown, THandle>}                    childNode - Child step AST node to execute.
 * @param {unknown}                                                   childIn   - Child step input payload.
 * @param {ExecuteDefaultChildStepContextParams<TIn, TOut, THandle>}  runCtx    - Child step execution context and enclosing parent agent session state.
 *
 * @returns {Promise<ChildForkExecutionOutcome<unknown>>} Completed child output or upward interrupt outcome.
 */
export async function executeDefaultChildStep<TIn, TOut, THandle>(
  childNode: StepASTNode<unknown, unknown, THandle>,
  childIn: unknown,
  runCtx: ExecuteDefaultChildStepContextParams<TIn, TOut, THandle>,
): Promise<ChildForkExecutionOutcome<unknown>> {
  const { childCtx, parent } = runCtx;
  const existingRuntime = getStepRuntimeInternals(childCtx) ?? {};
  const childOutcomeSink: {
    continuationStack?: readonly ContinuationFrame[];
    leafMessageId?: string | null;
    accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>;
    raisedByPhase?: 'act' | 'evaluate';
    suspendedAtCallId?: string;
  } = {};
  const enrichedCtx = Object.freeze({
    ...childCtx,
    _runtime: {
      ledgerStore: parent.ledgerStore,
      topologyStore: parent.topologyStore,
      lessonStore: parent.lessonStore,
      lockManager: parent.lockManager,
      continuationQueue: parent.continuationQueue,
      poolManager: parent.poolManager,
      serviceRegistry: parent.serviceRegistry,
      humanAdaptersById: parent.humanAdaptersById,
      ...existingRuntime,
      childOutcomeSink,
    },
  });
  try {
    const nodeType = (childNode as { readonly type: string }).type;
    let output: unknown;
    if (nodeType === 'harness:agent') {
      output = await executeAgent(
        childNode as AgentNode<unknown, unknown, THandle>,
        childIn,
        enrichedCtx,
      );
    } else if (nodeType === 'harness:loop') {
      output = await executeLoop(
        childNode as LoopNode<unknown, unknown, THandle>,
        childIn,
        enrichedCtx,
      );
    } else {
      output = await executeStepNode(childNode, childIn, enrichedCtx);
    }
    return Object.freeze<ChildForkExecutionOutcome<unknown>>({
      status: 'completed',
      output,
      leafMessageId: childOutcomeSink.leafMessageId,
      accumulatedLessonOutcomes: childOutcomeSink.accumulatedLessonOutcomes,
      continuationStack: childOutcomeSink.continuationStack ?? Object.freeze([]),
    });
  } catch (err) {
    const intrErr = err as {
      readonly interruptResolution?: { readonly interruptId: string; readonly payload: unknown };
      readonly raisedByPhase?: 'act' | 'evaluate';
      readonly suspendedAtCallId?: string;
    };
    if (intrErr.interruptResolution !== undefined) {
      return Object.freeze<ChildForkExecutionOutcome<unknown>>({
        status: 'interrupt-raised',
        interruptId: intrErr.interruptResolution.interruptId,
        interruptPayload: intrErr.interruptResolution.payload,
        raisedByPhase: intrErr.raisedByPhase ?? childOutcomeSink.raisedByPhase ?? 'act',
        suspendedAtCallId: intrErr.suspendedAtCallId ?? childOutcomeSink.suspendedAtCallId,
        leafMessageId: childOutcomeSink.leafMessageId,
        accumulatedLessonOutcomes: childOutcomeSink.accumulatedLessonOutcomes,
        continuationStack: childOutcomeSink.continuationStack ?? Object.freeze([]),
      });
    }
    throw err;
  }
}
