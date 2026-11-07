import type { AdjudicateInterruptHandlerNode } from '../../../ast/adjudicate-interrupt-handler-node.js';
import type { AskInterruptHandlerNode } from '../../../ast/ask-interrupt-handler-node.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { LeaseDelta } from '../../../ports/lease-delta.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import type { InterruptEdgeResolution } from '../interrupt-edge-resolution.js';

/**
 * Attaches granted `LeaseDelta` entries to the outer actor's `activeLeases` and any enclosing `loop-frame.grantedLoopLeases` (`SPEC.md` §3.5 & §3.8).
 *
 * Ensures capability leases elevated during `.onInterrupt()` or nested `.adjudicateWith()` persist across turns and loop iterations.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session       - Active agent turn session state.
 * @param {readonly LeaseDelta[]}                     grantedLeases - Leases granted by `.elevateLeaseWhen(...)`.
 */
export function attachElevatedLeasesToOuterActor<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  grantedLeases: readonly LeaseDelta[],
): void {
  if (grantedLeases.length === 0) {
    return;
  }
  session.agentFrame = Object.freeze<AgentContinuationFrame>({
    ...session.agentFrame,
    activeLeases: Object.freeze([...session.agentFrame.activeLeases, ...grantedLeases]),
  });
  for (let idx = 0; idx < session.outerFrames.length; idx += 1) {
    const outer = session.outerFrames[idx];
    if (outer?.kind === 'loop-frame') {
      session.outerFrames[idx] = Object.freeze<LoopContinuationFrame>({
        ...outer,
        grantedLoopLeases: Object.freeze([...outer.grantedLoopLeases, ...grantedLeases]),
      });
    }
  }
}

/**
 * Executes a bidirectional `.ask(human, schema)` interrupt handler edge and returns the resumption resolution (`SPEC.md` §3.5 & §3.6).
 *
 * Persists `humanRequestId` in `AdjudicationPauseState` before invoking `HumanAdapter.requestDecision()` for crash-safe deduplication.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session          - Active agent turn session state.
 * @param {AskInterruptHandlerNode}                   handler          - Matched `.ask(...)` handler node.
 * @param {unknown}                                   validatedPayload - Schema-validated interrupt payload.
 *
 * @returns {Promise<InterruptEdgeResolution<THandle>>} Resumption feedback and any elevated leases.
 */
export async function runHumanAskEdge<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  handler: AskInterruptHandlerNode,
  validatedPayload: unknown,
): Promise<InterruptEdgeResolution<THandle>> {
  const isInitialSpeculateRace =
    session.outerFrames.some((f) => f.kind === 'speculate-frame' && f.phase === 'RACING') ||
    (session.ctx.stepExecId.includes(':branch:') &&
      !session.outerFrames.some((f) => f.kind === 'speculate-frame'));
  if (isInitialSpeculateRace) {
    return Object.freeze<InterruptEdgeResolution<THandle>>({
      status: 'unhandled',
      grantedLeases: Object.freeze([]),
      interruptId: handler.interrupt.id,
      payload: validatedPayload,
    });
  }
  const humanAdapter = session.humanAdaptersById.get(handler.human.id);
  if (humanAdapter === undefined) {
    throw new Error(
      `No HumanAdapter registered for '${handler.human.id}' in agent '${session.node.id}'.`,
    );
  }
  const existingBatch =
    session.agentFrame.pauseState.kind === 'tool-batch'
      ? session.agentFrame.pauseState.pendingToolBatch
      : undefined;
  const reqId = `human-req:${session.ctx.stepExecId}:${handler.interrupt.id}:${String(session.agentFrame.turnsTaken)}`;
  session.agentFrame = Object.freeze<AgentContinuationFrame>({
    ...session.agentFrame,
    pauseState: Object.freeze({
      kind: 'adjudication',
      pendingToolBatch: existingBatch,
      pendingAdjudication: Object.freeze({
        interruptId: handler.interrupt.id,
        interruptPayloadJson: JSON.stringify(validatedPayload),
        humanRequestId: reqId,
      }),
    }),
  });
  if (session.ledgerStore !== undefined) {
    const ledgerStore = session.ledgerStore;
    const stack: readonly ContinuationFrame[] = Object.freeze([
      ...session.outerFrames,
      session.agentFrame,
    ]);
    await session.continuationQueue.enqueueUpdate(session.ctx.stepExecId, () =>
      ledgerStore.updateContinuationStack(
        session.ctx.runId,
        session.ctx.stepExecId,
        stack,
      ),
    );
  }
  const rawDecision = await humanAdapter.requestDecision({
    runId: session.ctx.runId,
    requestId: reqId,
    humanId: handler.human.id,
    payload: validatedPayload,
    responseSchema: handler.responseSchema,
    keepAliveSeconds: handler.human.keepAliveSeconds,
    signal: session.ctx.signal,
  });
  const decision = handler.responseSchema.parse(rawDecision);
  const grantedLeases: LeaseDelta[] = [];
  if (handler.elevateLeaseWhen?.predicate(decision) === true) {
    grantedLeases.push(handler.elevateLeaseWhen.leaseMapper(decision));
    attachElevatedLeasesToOuterActor(session, grantedLeases);
  }
  const feedback = handler.resumeWith(decision);
  return Object.freeze<InterruptEdgeResolution<THandle>>({
    status: 'resumed',
    feedback,
    grantedLeases: Object.freeze(grantedLeases),
    interruptId: handler.interrupt.id,
    payload: validatedPayload,
  });
}

/**
 * Executes a `.adjudicateWith(adjudicator, ...)` interrupt handler edge, including nested `.onInterrupt()` escalation (`SPEC.md` §3.5).
 *
 * Attaches any leases granted by nested `.onInterrupt()` or `handler.elevateLeaseWhen` to the outer interrupted actor.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>}             session          - Active agent turn session state.
 * @param {AdjudicateInterruptHandlerNode<TIn, unknown, THandle>} handler          - Matched `.adjudicateWith(...)` handler node.
 * @param {unknown}                                               validatedPayload - Schema-validated interrupt payload.
 *
 * @returns {Promise<InterruptEdgeResolution<THandle>>} Resumption feedback and any elevated leases.
 */
export async function runAdjudicatorEdge<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  handler: AdjudicateInterruptHandlerNode<TIn, unknown, THandle>,
  validatedPayload: unknown,
): Promise<InterruptEdgeResolution<THandle>> {
  const existingBatch =
    session.agentFrame.pauseState.kind === 'tool-batch'
      ? session.agentFrame.pauseState.pendingToolBatch
      : undefined;
  const adjudicatorInput = handler.mapInput(session.validatedInput, validatedPayload);
  const grantedLeases: LeaseDelta[] = [];
  const adjStepExecId = `${session.ctx.stepExecId}:adj:${handler.adjudicator.id}:${String(session.agentFrame.turnsTaken)}:L${String(session.agentFrame.activeLeases.length)}`;
  const parentRt = (session.ctx as { readonly _runtime?: Record<string, unknown> })._runtime ?? {};
  const adjCtx = Object.freeze({
    ...session.ctx,
    stepExecId: adjStepExecId,
    resumeContinuationStack: undefined,
    _runtime: {
      ...parentRt,
      existingAgentFrame: undefined,
      overrideModelNode: undefined,
      outerFrames: [...session.outerFrames, session.agentFrame],
    },
  });
  let adjOutcome = await session.executeChildStep(
    handler.adjudicator,
    adjudicatorInput,
    adjCtx,
  );
  if (adjOutcome.status === 'interrupt-raised' && adjOutcome.interruptId !== undefined) {
    const nested = handler.onInterruptHandlers.find(
      (h) => h.interrupt.id === adjOutcome.interruptId,
    );
    if (nested === undefined) {
      return Object.freeze<InterruptEdgeResolution<THandle>>({
        status: 'unhandled',
        grantedLeases: Object.freeze([]),
        interruptId: adjOutcome.interruptId,
        payload: adjOutcome.interruptPayload,
      });
    }
    const nestedPayload = nested.interrupt.schema.parse(adjOutcome.interruptPayload);
    if (nested.mode === 'ask') {
      const askRes = await runHumanAskEdge(session, nested, nestedPayload);
      if (askRes.status !== 'resumed') {
        return askRes;
      }
      for (const l of askRes.grantedLeases) {
        grantedLeases.push(l);
      }
      const resumedAdjCtx = Object.freeze({
        ...adjCtx,
        stepExecId: `${adjStepExecId}:resumed`,
      });
      const baseInput =
        typeof adjudicatorInput === 'object' && adjudicatorInput !== null
          ? adjudicatorInput
          : { input: adjudicatorInput };
      adjOutcome = await session.executeChildStep(
        handler.adjudicator,
        Object.freeze({ ...baseInput, _resumeFeedback: askRes.feedback }),
        resumedAdjCtx,
      );
    }
  }
  if (adjOutcome.status !== 'completed') {
    return Object.freeze<InterruptEdgeResolution<THandle>>({
      status: 'unhandled',
      grantedLeases: Object.freeze(grantedLeases),
      interruptId: adjOutcome.interruptId ?? handler.interrupt.id,
      payload: adjOutcome.interruptPayload ?? validatedPayload,
    });
  }
  if (
    handler.elevateLeaseWhen?.predicate(
      session.validatedInput,
      validatedPayload,
      adjOutcome.output,
    ) === true
  ) {
    const delta = handler.elevateLeaseWhen.leaseMapper(
      session.validatedInput,
      validatedPayload,
      adjOutcome.output,
    );
    grantedLeases.push(delta);
    attachElevatedLeasesToOuterActor(session, [delta]);
  }
  if (existingBatch !== undefined) {
    session.agentFrame = Object.freeze<AgentContinuationFrame>({
      ...session.agentFrame,
      pauseState: Object.freeze({ kind: 'tool-batch', pendingToolBatch: existingBatch }),
    });
  }
  const feedback = handler.resumeWith(
    session.validatedInput,
    validatedPayload,
    adjOutcome.output,
  );
  return Object.freeze<InterruptEdgeResolution<THandle>>({
    status: 'resumed',
    feedback,
    grantedLeases: Object.freeze(grantedLeases),
    interruptId: handler.interrupt.id,
    payload: validatedPayload,
  });
}

/**
 * Matches a raised `(interruptId, rawPayload)` against the agent's `.onInterrupt()` edges and executes the matched handler (`SPEC.md` §3.5).
 *
 * Returns `status: 'unhandled'` when no local handler matches so enclosing `H.loop`, parent `.onChildInterrupt()`, or `H.flow` can intercept.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session     - Active agent turn session state.
 * @param {string}                                    interruptId - Identifier of the raised `InterruptNode`.
 * @param {unknown}                                   rawPayload  - Unvalidated interrupt payload.
 *
 * @returns {Promise<InterruptEdgeResolution<THandle>>} Resolution outcome (`'resumed'`, `'replace'`, or `'unhandled'`).
 */
export async function resolveInterruptEdge<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  interruptId: string,
  rawPayload: unknown,
): Promise<InterruptEdgeResolution<THandle>> {
  const handler = session.node.onInterruptHandlers.find((h) => h.interrupt.id === interruptId);
  if (handler === undefined) {
    return Object.freeze<InterruptEdgeResolution<THandle>>({
      status: 'unhandled',
      grantedLeases: Object.freeze([]),
      interruptId,
      payload: rawPayload,
    });
  }
  const validatedPayload = handler.interrupt.schema.parse(rawPayload);
  if (handler.mode === 'replace') {
    return Object.freeze<InterruptEdgeResolution<THandle>>({
      status: 'replace',
      grantedLeases: Object.freeze([]),
      replaceHandler: handler,
      interruptId,
      payload: validatedPayload,
    });
  }
  if (handler.mode === 'ask') {
    return runHumanAskEdge(session, handler, validatedPayload);
  }
  return runAdjudicatorEdge(session, handler, validatedPayload);
}
