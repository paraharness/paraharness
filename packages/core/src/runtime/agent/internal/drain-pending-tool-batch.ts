import type { AgentNode } from '../../../ast/agent-node.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { BranchableScope } from '../../../ports/branchable-scope.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type {
  CompletedToolBatchResultRecord,
  PendingToolBatch,
  RemainingToolCallRecord,
} from '../../../ports/pending-tool-batch.js';
import type { ToolEffect } from '../../../ports/tool-effect.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import { executeForkBatch } from '../../fork/execute-fork-batch.js';
import type { ForkDispatchCallItem } from '../../fork/fork-batch-execution-params.js';
import {
  evaluatePreFlightToolBatch,
  evaluateQuotaTripwires,
} from '../../policy/evaluate-policy-guards.js';
import { executeLimitExceededSequence } from '../../policy/execute-limit-exceeded-flush.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import type { DrainToolBatchOutcome } from '../drain-tool-batch-outcome.js';
import type { InterruptEdgeResolution } from '../interrupt-edge-resolution.js';
import { dispatchSingleToolCall } from './dispatch-single-tool-call.js';
import { resolveInterruptEdge } from './resolve-interrupt-edge.js';

/**
 * Collects and executes a contiguous slice of `.fork()` calls from the front of `remainingCalls` as a single concurrent batch (`SPEC.md` §3.5 & §3.7.2).
 *
 * Forwards `precedingCompletedResults` and `siblingForkCallIds` to `executeForkBatch` (and `ModelDriver.prepareFork`)
 * and appends each settled fork result to `completedResults`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session          - Active agent turn session state.
 * @param {RemainingToolCallRecord[]}                 remainingCalls   - Mutable remaining calls queue starting with a `.fork()` call.
 * @param {CompletedToolBatchResultRecord[]}          completedResults - Mutable completed results list for the turn batch.
 *
 * @returns {Promise<boolean>} True when at least one fork call was batched and drained from the front of `remainingCalls`.
 */
export async function drainContiguousForkSlice<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  remainingCalls: RemainingToolCallRecord[],
  completedResults: CompletedToolBatchResultRecord[],
): Promise<boolean> {
  const forksByToolName = new Map(
    (session.node.capabilities?.forks ?? []).map((f) => [f.toolName, f] as const),
  );
  const forkCalls: ForkDispatchCallItem<THandle>[] = [];
  while (remainingCalls.length > 0) {
    const head = remainingCalls[0];
    const forkCap = head !== undefined ? forksByToolName.get(head.toolName) : undefined;
    if (head === undefined || forkCap === undefined) {
      break;
    }
    remainingCalls.shift();
    const args = JSON.parse(head.argsJson || '{}') as Record<string, unknown>;
    forkCalls.push(
      Object.freeze<ForkDispatchCallItem<THandle>>({
        callId: head.callId,
        forkId: String(args['forkId'] ?? `${head.callId}:${String(forkCalls.length)}`),
        capability: forkCap as never,
        argsJson: head.argsJson,
      }),
    );
  }
  if (forkCalls.length === 0) {
    return false;
  }
  const rtScope = (session.ctx as { readonly _runtime?: { readonly branchableScope?: unknown } })
    ._runtime?.branchableScope;
  const scopeFactory =
    session.ctx.scopeNode !== undefined
      ? session.ctx.registry.scopes[session.ctx.scopeNode.type]
      : undefined;
  const scopeDriver = (session.ctx.scope ??
    rtScope ??
    (scopeFactory !== undefined && session.ctx.scopeNode !== undefined
      ? scopeFactory(session.ctx.scopeNode as never, {
          registry: session.ctx.registry,
          resolveEnv: (v) => session.ctx.resolveEnv(v),
          getRunner: (n) => session.ctx.getRunner(n),
        })
      : undefined)) as BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>;
  const precedingResults = [];
  for (const r of completedResults) {
    precedingResults.push(
      Object.freeze({ callId: r.callId, content: r.content, isError: Boolean(r.isError) }),
    );
  }
  const siblingIds: string[] = [];
  for (const fc of forkCalls) {
    siblingIds.push(fc.callId);
  }
  const fRes = await executeForkBatch({
    parentNode: session.node as AgentNode<unknown, unknown, THandle>,
    parentInput: session.validatedInput,
    parentLeafMessageId: session.agentFrame.leafMessageId,
    outerFrames: [...session.outerFrames, session.agentFrame],
    forkCalls,
    precedingCompletedResults: Object.freeze(precedingResults),
    siblingForkCallIds: Object.freeze(siblingIds),
    branchableScope: scopeDriver,
    lockManager: session.lockManager,
    continuationQueue: session.continuationQueue,
    ledgerStore: session.ledgerStore as NonNullable<typeof session.ledgerStore>,
    lessonStore: session.lessonStore,
    poolManager: session.poolManager,
    modelDriver: session.modelDriver,
    wirePrefix: session.wirePrefix,
    humanAdaptersById: session.humanAdaptersById,
    ctx: session.ctx,
    executeChildStep: session.executeChildStep,
  });
  if (fRes.batchFrame.forks.some((f) => f.conflictCheckArmed)) {
    session.agentFrame = Object.freeze<AgentContinuationFrame>({
      ...session.agentFrame,
      conflictCheckArmed: true,
    });
  }
  for (const fc of forkCalls) {
    const outEntry = fRes.toolResultsByCallId.get(fc.callId);
    completedResults.push(
      Object.freeze<CompletedToolBatchResultRecord>({
        callId: fc.callId,
        content: outEntry?.content ?? JSON.stringify(fRes.batchFrame),
        isError: outEntry?.isError ?? false,
      }),
    );
  }
  return true;
}

/**
 * Evaluates pre-flight policy guards across `remainingCalls` `(i..k)` when `remainingCalls[0]` is a `'declared'` unlocked tool (`SPEC.md` §3.5).
 *
 * Batches trailing calls failing the exact same `'raise-interrupt'` clause $C$ and runs `.onInterrupt()` adjudication.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session        - Active agent turn session state.
 * @param {RemainingToolCallRecord[]}                 remainingCalls - Mutable remaining calls queue `(i..k)`.
 * @param {object}                                    state          - Mutable batch state (`completedResults` and `adjudicationFeedback`).
 *
 * @returns {Promise<{ readonly status: 'proceed' | 'denied-in-band' | 'lease-denied' | 're-evaluate' | 'interrupted'; readonly interruptResolution?: InterruptEdgeResolution<THandle> }>} Pre-flight gate outcome.
 */
export async function evaluateAndAdjudicatePreFlightCall<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  remainingCalls: RemainingToolCallRecord[],
  state: {
    readonly completedResults: CompletedToolBatchResultRecord[];
    adjudicationFeedback: string | undefined;
  },
): Promise<{
  readonly status:
    | 'proceed'
    | 'denied-in-band'
    | 'lease-denied'
    | 're-evaluate'
    | 'interrupted';
  readonly interruptResolution?: InterruptEdgeResolution<THandle>;
}> {
  const call = remainingCalls[0];
  if (call === undefined || session.node.policy === undefined) {
    return Object.freeze({ status: 'proceed' });
  }
  const requiredSkillId = session.skillOwnerByToolName.get(call.toolName);
  if (
    requiredSkillId !== undefined &&
    !new Set(session.agentFrame.activeSkillIds).has(requiredSkillId)
  ) {
    return Object.freeze({ status: 'proceed' });
  }
  const toolNode = session.toolsByName.get(call.toolName);
  if (toolNode === undefined || toolNode.effectTracking !== 'declared') {
    return Object.freeze({ status: 'proceed' });
  }
  const preEval = await evaluatePreFlightToolBatch({
    policy: session.node.policy,
    remainingCalls,
    toolsByName: session.toolsByName,
    activeLeases: session.agentFrame.activeLeases,
    ctx: session.ctx,
  });
  if (preEval.status === 'allowed') {
    return Object.freeze({ status: 'proceed' });
  }
  if (preEval.status === 'denied-with-error') {
    remainingCalls.shift();
    state.completedResults.push(
      Object.freeze<CompletedToolBatchResultRecord>({
        callId: call.callId,
        content: preEval.deniedErrorMessage ?? 'Denied',
        isError: true,
      }),
    );
    return Object.freeze({ status: 'denied-in-band' });
  }
  if (
    call.blockedPreFlight === true &&
    (preEval.violatedClauseId === undefined ||
      new Set(call.adjudicatedClauseIds).has(preEval.violatedClauseId))
  ) {
    remainingCalls.shift();
    state.completedResults.push(
      Object.freeze<CompletedToolBatchResultRecord>({
        callId: call.callId,
        content: `[Lease Denied: ${state.adjudicationFeedback ?? ''}]`,
        isError: true,
      }),
    );
    return Object.freeze({ status: 'lease-denied' });
  }
  if (preEval.updatedRemainingCalls !== undefined) {
    remainingCalls.splice(0, remainingCalls.length, ...preEval.updatedRemainingCalls);
  }
  const snapBatch: PendingToolBatch = Object.freeze({
    completedResults: Object.freeze([...state.completedResults]),
    blockedCalls: preEval.blockedCalls ?? Object.freeze([]),
    remainingCalls: Object.freeze([...remainingCalls]),
    activeInterruptCallId: call.callId,
    adjudicationFeedback: state.adjudicationFeedback,
  });
  session.agentFrame = Object.freeze<AgentContinuationFrame>({
    ...session.agentFrame,
    pauseState: Object.freeze({ kind: 'tool-batch', pendingToolBatch: snapBatch }),
  });
  const intrRes = await resolveInterruptEdge(
    session,
    preEval.raisedInterrupt?.id ?? 'policy-interrupt',
    preEval.interruptPayload,
  );
  if (intrRes.status !== 'resumed') {
    return Object.freeze({ status: 'interrupted', interruptResolution: intrRes });
  }
  state.adjudicationFeedback = intrRes.feedback;
  return Object.freeze({ status: 're-evaluate' });
}

/**
 * Evaluates post-tool `QuotaTripwire` thresholds and runs the 4-step `.onLimitExceeded()` sequence when tripped (`SPEC.md` §3.5).
 *
 * Synthesizes `[Aborted: Limit Exceeded]` for unexecuted `remainingCalls` before invoking the epistemic flush turn.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session     - Active agent turn session state.
 * @param {readonly ToolEffect[]}                     prevEffects - Effects accumulated prior to the current tool call.
 * @param {object}                                    batchCtx    - Current tool effects, completed results, and remaining calls.
 *
 * @returns {Promise<InterruptEdgeResolution<THandle> | undefined>} Interrupt resolution when tripped and not resumed, or `undefined`.
 */
export async function evaluatePostToolTripwireAndFlush<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  prevEffects: readonly ToolEffect[],
  batchCtx: {
    readonly newEffects: readonly ToolEffect[];
    readonly completedResults: readonly CompletedToolBatchResultRecord[];
    readonly remainingCalls: readonly RemainingToolCallRecord[];
  },
): Promise<InterruptEdgeResolution<THandle> | undefined> {
  if (batchCtx.newEffects.length === 0) {
    return undefined;
  }
  const twRes = await evaluateQuotaTripwires(
    session.node.policy,
    { accumulatedEffects: prevEffects, newEffects: batchCtx.newEffects },
    session.ctx,
  );
  if (!twRes.tripped || session.node.policy?.onLimitExceeded === undefined) {
    return undefined;
  }
  const limCfg = session.node.policy.onLimitExceeded;
  const hasReplaceAbortHook = session.node.onInterruptHandlers.some(
    (h) =>
      h.interrupt.id === limCfg.flushInterrupt.id &&
      h.mode === 'replace' &&
      h.abortHook !== undefined,
  );
  const pendingToolBatch: PendingToolBatch = Object.freeze({
    completedResults: Object.freeze([...batchCtx.completedResults]),
    blockedCalls: Object.freeze([]),
    remainingCalls: Object.freeze([...batchCtx.remainingCalls]),
  });
  const flushPayload =
    session.ledgerStore !== undefined
      ? (
          await executeLimitExceededSequence({
            agentFrame: session.agentFrame,
            outerFrames: session.outerFrames,
            pendingToolBatch,
            limitConfig: limCfg,
            modelNode: session.modelNode,
            modelDriver: session.modelDriver,
            wirePrefix: session.wirePrefix,
            ledgerStore: session.ledgerStore,
            continuationQueue: session.continuationQueue,
            topologyStore: session.topologyStore,
            serviceRegistry: session.serviceRegistry,
            baseScopeCheckpoint: hasReplaceAbortHook
              ? undefined
              : session.baseScopeCheckpoint,
            tripReason: twRes.reason ?? 'Quota tripwire exceeded',
            ctx: session.ctx,
          })
        ).flushedPayload
      : Object.freeze({ reason: twRes.reason ?? 'Quota tripwire exceeded' });
  const intrRes = await resolveInterruptEdge(
    session,
    limCfg.flushInterrupt.id,
    flushPayload,
  );
  return intrRes.status === 'resumed' ? undefined : intrRes;
}

/**
 * Appends the completed `role: 'tool'` wire frame to `session.ledgerStore` and resets `pauseState` to `'active-turn'` (`SPEC.md` §3.5 & §3.7.2).
 *
 * Ensures all `(1..k)` tool results from a single model turn are committed in one consolidated tool frame.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>}   session          - Active agent turn session state.
 * @param {readonly CompletedToolBatchResultRecord[]}   completedResults - Completed tool results for the turn batch.
 *
 * @returns {Promise<void>} Resolves once the wire frame is appended and `session.agentFrame` is updated.
 */
async function appendCompletedToolBatchWireFrame<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  completedResults: readonly CompletedToolBatchResultRecord[],
): Promise<void> {
  if (session.ledgerStore === undefined || completedResults.length === 0) {
    return;
  }
  const toolMsgId = `msg:${session.ctx.stepExecId}:tools:${String(session.agentFrame.turnsTaken)}`;
  const frameJson = JSON.stringify(completedResults);
  const canonicalResults = [];
  for (const r of completedResults) {
    canonicalResults.push(
      Object.freeze({ callId: r.callId, content: r.content, isError: Boolean(r.isError) }),
    );
  }
  await session.ledgerStore.appendMessageFrame(
    session.ctx.runId,
    Object.freeze<WireFrameRecord>({
      messageId: toolMsgId,
      parentMessageId: session.agentFrame.leafMessageId,
      vendorId: session.modelNode.vendor,
      rawWireFrame: new TextEncoder().encode(frameJson),
      canonical: Object.freeze({
        role: 'tool',
        visibleText: frameJson,
        toolResults: Object.freeze(canonicalResults),
      }),
      prefixDigest: session.wirePrefix?.systemDigest ?? 'unpinned',
    }),
  );
  session.agentFrame = Object.freeze<AgentContinuationFrame>({
    ...session.agentFrame,
    leafMessageId: toolMsgId,
    pausedAtPhase: 'TOOL_BOUNDARY',
    pauseState: Object.freeze({ kind: 'active-turn' }),
  });
}

/**
 * Drains `PendingToolBatch.remainingCalls` in strict `(1..k)` declaration order and writes a single `role: 'tool'` wire frame (`SPEC.md` §3.5 & §3.7.2).
 *
 * Handles contiguous `.fork()` batching, pre-flight `'raise-interrupt'` batching, `[SERVICE_REACQUIRED]` notes,
 * `[Lease Elevated]` / `[Lease Denied]` prefixes, post-tool `QuotaTripwire` flushes, and dependent call skipping.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session      - Active agent turn session state.
 * @param {PendingToolBatch}                          initialBatch - Initial or resumed `PendingToolBatch` state.
 *
 * @returns {Promise<DrainToolBatchOutcome<THandle>>} Final drain outcome (`'completed'`, `'suspended'`, or `'interrupted'`).
 */
export async function drainPendingToolBatch<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  initialBatch: PendingToolBatch,
): Promise<DrainToolBatchOutcome<THandle>> {
  const reacquiredNotes = await session.serviceRegistry.reacquireActiveSkillServices({
    runId: session.ctx.runId,
    scopeKey: session.ctx.stepExecId,
    scopeHandle: session.ctx.scopeHandle,
    activeSkillIds: session.agentFrame.activeSkillIds,
    skillsById: session.skillsById,
    driverContext: {
      registry: session.ctx.registry,
      resolveEnv: (v) => session.ctx.resolveEnv(v),
      getRunner: (n) => session.ctx.getRunner(n),
    },
  });
  const completedResults: CompletedToolBatchResultRecord[] = [
    ...initialBatch.completedResults,
  ];
  const remainingCalls: RemainingToolCallRecord[] = [...initialBatch.remainingCalls];
  const batchState = {
    completedResults,
    adjudicationFeedback: initialBatch.adjudicationFeedback,
  };
  let precedingReplayCallDenied = false;
  let reacquiredNotesAttached = false;
  while (remainingCalls.length > 0) {
    const call = remainingCalls[0] as RemainingToolCallRecord;
    if (precedingReplayCallDenied) {
      const skipped = remainingCalls.shift() as RemainingToolCallRecord;
      completedResults.push(
        Object.freeze<CompletedToolBatchResultRecord>({
          callId: skipped.callId,
          content: '[Skipped: Preceding tool call in turn batch was denied]',
          isError: true,
        }),
      );
      continue;
    }
    if (await drainContiguousForkSlice(session, remainingCalls, completedResults)) {
      continue;
    }
    const preOut = await evaluateAndAdjudicatePreFlightCall(
      session,
      remainingCalls,
      batchState,
    );
    if (preOut.status === 're-evaluate' || preOut.status === 'denied-in-band') {
      continue;
    }
    if (preOut.status === 'lease-denied') {
      precedingReplayCallDenied = true;
      continue;
    }
    const curBatch = Object.freeze<PendingToolBatch>({
      completedResults: Object.freeze([...completedResults]),
      blockedCalls: Object.freeze([]),
      remainingCalls: Object.freeze([...remainingCalls]),
      adjudicationFeedback: batchState.adjudicationFeedback,
    });
    if (preOut.status === 'interrupted') {
      return Object.freeze<DrainToolBatchOutcome<THandle>>({
        status: 'interrupted',
        batch: curBatch,
        interruptResolution: preOut.interruptResolution,
      });
    }
    const prevEffects = session.agentFrame.observedEffects;
    const stepOut = await dispatchSingleToolCall(session, call, curBatch);
    if (stepOut.status === 'interrupted') {
      const intrBatch = Object.freeze<PendingToolBatch>({
        ...curBatch,
        activeInterruptCallId: call.callId,
      });
      session.agentFrame = Object.freeze<AgentContinuationFrame>({
        ...session.agentFrame,
        pauseState: Object.freeze({ kind: 'tool-batch', pendingToolBatch: intrBatch }),
      });
      return Object.freeze<DrainToolBatchOutcome<THandle>>({
        status: 'interrupted',
        batch: intrBatch,
        interruptResolution: stepOut.interruptResolution,
      });
    }
    remainingCalls.shift();
    if (stepOut.newEffects !== undefined && stepOut.newEffects.length > 0) {
      (
        session.ctx as { readonly recordEffects?: (effs: readonly ToolEffect[]) => void }
      ).recordEffects?.(stepOut.newEffects);
    }
    const prefix =
      call.blockedPreFlight === true && batchState.adjudicationFeedback !== undefined
        ? `[Lease Elevated: ${batchState.adjudicationFeedback}]\n\n`
        : '';
    let svcPrefix = '';
    if (!reacquiredNotesAttached && reacquiredNotes.length > 0) {
      reacquiredNotesAttached = true;
      svcPrefix = `${reacquiredNotes.join('\n')}\n`;
    }
    completedResults.push(
      Object.freeze<CompletedToolBatchResultRecord>({
        callId: call.callId,
        content: `${svcPrefix}${prefix}${stepOut.content}`,
        isError: stepOut.isError,
      }),
    );
    const settledBatch = Object.freeze<PendingToolBatch>({
      completedResults: Object.freeze([...completedResults]),
      blockedCalls: Object.freeze([]),
      remainingCalls: Object.freeze([...remainingCalls]),
      adjudicationFeedback: batchState.adjudicationFeedback,
    });
    if (stepOut.status === 'suspended') {
      session.agentFrame = Object.freeze<AgentContinuationFrame>({
        ...session.agentFrame,
        pausedAtPhase: 'TOOL_BOUNDARY',
        pauseState: Object.freeze({
          kind: 'prerequisite-wait',
          pendingToolBatch: curBatch,
        }),
      });
      return Object.freeze<DrainToolBatchOutcome<THandle>>({
        status: 'suspended',
        batch: settledBatch,
      });
    }
    const twIntr = await evaluatePostToolTripwireAndFlush(session, prevEffects, {
      newEffects: stepOut.newEffects ?? [],
      completedResults,
      remainingCalls,
    });
    if (twIntr !== undefined) {
      return Object.freeze<DrainToolBatchOutcome<THandle>>({
        status: 'interrupted',
        batch: settledBatch,
        interruptResolution: twIntr,
      });
    }
    session.agentFrame = Object.freeze<AgentContinuationFrame>({
      ...session.agentFrame,
      pauseState: Object.freeze({ kind: 'tool-batch', pendingToolBatch: settledBatch }),
    });
    if (session.ledgerStore !== undefined) {
      const ledgerStore = session.ledgerStore;
      await session.continuationQueue.enqueueUpdate(session.ctx.stepExecId, () =>
        ledgerStore.updateContinuationStack(
          session.ctx.runId,
          session.ctx.stepExecId,
          Object.freeze<readonly ContinuationFrame[]>([
            ...session.outerFrames,
            session.agentFrame,
          ]),
        ),
      );
    }
  }
  if (!reacquiredNotesAttached && reacquiredNotes.length > 0 && completedResults.length > 0) {
    const lastIdx = completedResults.length - 1;
    const lastEntry = completedResults[lastIdx] as CompletedToolBatchResultRecord;
    completedResults[lastIdx] = Object.freeze<CompletedToolBatchResultRecord>({
      ...lastEntry,
      content: `${lastEntry.content}\n${reacquiredNotes.join('\n')}`,
    });
  }
  const finalBatch = Object.freeze<PendingToolBatch>({
    completedResults: Object.freeze([...completedResults]),
    blockedCalls: Object.freeze([]),
    remainingCalls: Object.freeze([]),
    adjudicationFeedback: batchState.adjudicationFeedback,
  });
  await appendCompletedToolBatchWireFrame(session, completedResults);
  return Object.freeze<DrainToolBatchOutcome<THandle>>({
    status: 'completed',
    batch: finalBatch,
  });
}
