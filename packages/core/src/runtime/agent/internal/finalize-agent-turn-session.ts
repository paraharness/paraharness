import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import { getStepRuntimeInternals } from './get-step-runtime-internals.js';

/**
 * Projects final or suspended agent continuation state into `_runtime.childOutcomeSink` and quiesces step-scoped services (`SPEC.md` §3.4.2 & §3.7.2).
 *
 * Invoked in `executeAgent`'s `finally` block so enclosing `M.loop`, `.fork()`, and `.speculate()` handlers
 * receive the latest `agentFrame`, `leafMessageId`, `accumulatedLessonOutcomes`, and `suspendedAtCallId`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {StepExecutionContext<THandle>}             ctx     - Active step execution context.
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 *
 * @returns {Promise<void>} Resolves once outcome sink projection and service quiescing complete.
 */
export async function finalizeAgentTurnSession<TIn, TOut, THandle>(
  ctx: StepExecutionContext<THandle>,
  session: AgentTurnSessionState<TIn, TOut, THandle>,
): Promise<void> {
  const sink = getStepRuntimeInternals(ctx)?.childOutcomeSink;
  if (sink !== undefined) {
    sink.continuationStack = Object.freeze([session.agentFrame]);
    sink.leafMessageId = session.agentFrame.leafMessageId;
    sink.accumulatedLessonOutcomes = Object.freeze({
      ...session.accumulatedLessonOutcomes,
    });
    if (session.agentFrame.pauseState.kind === 'tool-batch') {
      const pendingBatch = session.agentFrame.pauseState.pendingToolBatch;
      sink.suspendedAtCallId =
        pendingBatch.activeInterruptCallId ?? pendingBatch.remainingCalls[0]?.callId;
    }
  }
  await session.serviceRegistry.quiesceScopeServices(ctx.stepExecId);
}
