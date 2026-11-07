import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import { getStepRuntimeInternals } from '../../agent/internal/get-step-runtime-internals.js';
import type { LoopExecutionState } from '../loop-execution-state.js';

/**
 * Projects a child loop's final or suspended continuation stack, leaf message ID, and lesson outcomes into `_runtime.childOutcomeSink` (`SPEC.md` §3.7.2 & §3.8).
 *
 * Invoked in `executeLoop`'s `finally` block so parent `.fork()` and `.speculate()` handlers can inspect
 * `raisedByPhase: 'act' | 'evaluate'`, `preservedActLeafMessageId`, and buffered lesson outcomes.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {StepExecutionContext<THandle>}          ctx   - Active step execution context.
 * @param {LoopExecutionState<TIn, TOut, THandle>} state - Loop execution state to project.
 */
export function projectLoopChildOutcomeSink<TIn = unknown, TOut = unknown, THandle = unknown>(
  ctx: StepExecutionContext<THandle>,
  state: LoopExecutionState<TIn, TOut, THandle>,
): void {
  const sink = getStepRuntimeInternals(ctx)?.childOutcomeSink;
  if (sink === undefined) {
    return;
  }
  sink.continuationStack =
    state.lastInnerAgentFrame !== undefined
      ? Object.freeze([state.loopFrame, state.lastInnerAgentFrame])
      : Object.freeze([state.loopFrame]);
  sink.leafMessageId =
    state.loopFrame.preservedActLeafMessageId ??
    (state.lastInnerAgentFrame?.kind === 'agent-frame'
      ? state.lastInnerAgentFrame.leafMessageId
      : null);
  sink.accumulatedLessonOutcomes = Object.freeze({ ...state.accumulatedLessonOutcomes });
  sink.raisedByPhase = state.loopFrame.phase;
  sink.suspendedAtCallId = state.lastSuspendedAtCallId;
}
