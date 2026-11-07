import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { CrossVerifierBranchCandidate } from '../../../ports/runtime-executor-registry.js';
import type {
  SpeculateBranchEntryRecord,
  SpeculateContinuationFrame,
  SpeculateHumanRulingRecord,
} from '../../../ports/speculate-continuation-frame.js';
import { executeDefaultForkOrTournamentChild } from '../../fork/internal/run-single-fork-call.js';
import type { PostRaceResolution } from '../post-race-resolution.js';
import type { SpeculateTournamentParams } from '../speculate-tournament-params.js';
import type { SpeculateTournamentResult } from '../speculate-tournament-result.js';
import type { UnparkBranchContext } from '../unpark-branch-context.js';
import type { UnparkBranchResult } from '../unpark-branch-result.js';
import type { ValidatedArbiterTurnResult } from '../validated-arbiter-turn-result.js';
import type { WinnerRefinementCommitContext } from '../winner-refinement-commit-context.js';
import {
  commitWinnerWithConflictBounce,
  flushCommittedWinnerLessons,
  mergeBranchBufferedOutcomes,
  promoteRefinedWinnerStack,
} from './commit-and-flush-tournament-winner.js';

/**
 * Classifies a completed speculative tournament race into Post-Race Cases 1–4 (`SPEC.md` §3.7.2 Capability 2).
 *
 * Never short-circuits the arbiter when $\ge 1$ branch is parked alongside a completed branch,
 * when $\ge 2$ branches are parked, or when `humanRulingsHistory.length > 0`.
 *
 * @param {readonly SpeculateBranchEntryRecord[]} branches            - Settled branch records (`0..B-1`).
 * @param {readonly SpeculateHumanRulingRecord[]} humanRulingsHistory - Prior human escalation rulings.
 *
 * @returns {PostRaceResolution} Resolved post-race case and optional target branch index.
 */
export function resolvePostRaceCases(
  branches: readonly SpeculateBranchEntryRecord[],
  humanRulingsHistory: readonly SpeculateHumanRulingRecord[],
): PostRaceResolution {
  const completed: SpeculateBranchEntryRecord[] = [];
  const parked: SpeculateBranchEntryRecord[] = [];
  for (const b of branches) {
    if (b.status === 'COMPLETED' || b.status === 'WINNER_COMMITTED') completed.push(b);
    else if (b.status === 'PARKED_ON_ESCALATION') parked.push(b);
  }
  if (completed.length === 0 && parked.length === 0) return Object.freeze<PostRaceResolution>({ caseKind: 'all-failed' });
  if (completed.length === 0 && parked.length === 1 && humanRulingsHistory.length === 0) return Object.freeze<PostRaceResolution>({ caseKind: 'unpark-sole-escalated', targetBranchIndex: parked[0]?.branchIndex });
  if (completed.length === 1 && parked.length === 0 && humanRulingsHistory.length === 0) return Object.freeze<PostRaceResolution>({ caseKind: 'sole-survivor', targetBranchIndex: completed[0]?.branchIndex });
  return Object.freeze<PostRaceResolution>({ caseKind: 'contested-arbitration' });
}

/**
 * Runs the tournament `crossVerifier` and `arbiter.actor` with built-in `beforeStop` candidate index validation (`SPEC.md` §3.7.2).
 *
 * Verifies that `'select-winner'` references a `COMPLETED` branch and `'unpark-escalation'` references
 * a `PARKED_ON_ESCALATION` branch, bouncing invalid indices up to 2 times.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>} params          - Tournament parameters.
 * @param {SpeculateContinuationFrame}         frame           - Current tournament continuation frame.
 * @param {ReadonlyMap<number, THandle>}       handlesByBranch - Live branch handles keyed by `branchIndex`.
 *
 * @returns {Promise<ValidatedArbiterTurnResult>} Validated arbiter verdict and decision.
 */
export async function runTournamentArbiterWithGate<THandle = unknown>(params: SpeculateTournamentParams<THandle>, frame: SpeculateContinuationFrame, handlesByBranch: ReadonlyMap<number, THandle>): Promise<ValidatedArbiterTurnResult> {
  const runStep = params.executeChildStep ?? ((cNode, cIn, cCtx) => executeDefaultForkOrTournamentChild(cNode, cIn, { childCtx: cCtx, ledgerStore: params.ledgerStore, lessonStore: params.lessonStore, lockManager: params.lockManager, continuationQueue: params.continuationQueue, humanAdaptersById: params.humanAdaptersById, outerFrames: [...params.outerFrames, frame] }));
  const crossCandidates: CrossVerifierBranchCandidate<THandle>[] = [];
  for (const b of frame.branches) {
    const h = handlesByBranch.get(b.branchIndex);
    if (b.status === 'COMPLETED' && h !== undefined) crossCandidates.push({ branchIndex: b.branchIndex, scopeHandle: h, scopeReceipt: JSON.parse(b.scopeReceiptJson ?? '{}') as Record<string, unknown> });
  }
  const cvExec = params.capability.crossVerifier !== undefined && crossCandidates.length > 0 ? params.ctx.registry.crossVerifiers[params.capability.crossVerifier.type] : undefined;
  const crossReports: Readonly<Record<number, unknown>> = cvExec !== undefined && params.capability.crossVerifier !== undefined ? await cvExec(params.capability.crossVerifier as never, crossCandidates, params.ctx as never) : {};
  const req = params.capability.requestSchema.parse(JSON.parse(params.argsJson || '{}'));
  const branchInputs = params.capability.mapBranches(params.parentInput, req);
  const candidates: Array<Record<string, unknown>> = [];
  const failedBranches: Array<{ readonly branchIndex: number; readonly errorSummary: string }> = [];
  for (const b of frame.branches) {
    if (b.status === 'FAILED') {
      failedBranches.push({ branchIndex: b.branchIndex, errorSummary: b.errorSummary ?? 'Failed' });
      continue;
    }
    const h = handlesByBranch.get(b.branchIndex);
    const receipt = b.scopeReceiptJson !== undefined ? JSON.parse(b.scopeReceiptJson) : (h !== undefined ? await params.branchableScope.inspect(h) : {});
    if (b.status === 'PARKED_ON_ESCALATION') {
      const escPayload = b.parkedEscalationPayloadJson !== undefined ? JSON.parse(b.parkedEscalationPayloadJson) : undefined;
      candidates.push({ status: 'PARKED_ON_ESCALATION', branchIndex: b.branchIndex, input: branchInputs[b.branchIndex], scopeReceipt: receipt, interruptId: b.parkedInterruptId ?? 'unknown', escalationPayload: escPayload, parkedInterruptId: b.parkedInterruptId, parkedEscalationPayload: escPayload });
    } else candidates.push({ status: 'COMPLETED', branchIndex: b.branchIndex, input: branchInputs[b.branchIndex], output: b.outputJson !== undefined ? JSON.parse(b.outputJson) : undefined, scopeReceipt: receipt, crossVerifyReport: crossReports[b.branchIndex], crossVerificationReport: crossReports[b.branchIndex] });
  }
  let validationFeedback: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const out = await runStep(params.capability.arbiter.actor, { parentInput: params.parentInput, candidates, failedBranches, humanRulingsHistory: frame.humanRulingsHistory, validationFeedback }, Object.freeze({ ...params.ctx, stepExecId: `${params.ctx.stepExecId}:arbiter:${String(frame.humanRulingsHistory.length)}:${String(attempt)}`, candidateHandles: handlesByBranch }));
    const decision = params.capability.arbiter.resolveDecision(out.output);
    const valid = decision.decision === 'reject-all' || (decision.decision === 'select-winner' && frame.branches.some((b) => b.branchIndex === decision.winnerBranchIndex && b.status === 'COMPLETED')) || (decision.decision === 'unpark-escalation' && frame.branches.some((b) => b.branchIndex === decision.parkedBranchIndex && b.status === 'PARKED_ON_ESCALATION'));
    if (valid) return Object.freeze<ValidatedArbiterTurnResult>({ verdict: out.output, decision });
    validationFeedback = `Invalid arbiter candidate index in decision '${decision.decision}'. Select a valid COMPLETED or PARKED_ON_ESCALATION branchIndex.`;
  }
  throw new Error(`Tournament arbiter '${params.capability.arbiter.actor.id}' failed candidate index validation after 3 attempts.`);
}

/**
 * Unparks a `PARKED_ON_ESCALATION` branch non-destructively while retaining all `COMPLETED` sibling handles (`SPEC.md` §3.7.2).
 *
 * Persists `humanRequestId` before calling `HumanAdapter.requestDecision` for exogenous human escalations,
 * or returns `ABORTED_ON_CHILD_INTERRUPT` when parked on an upward child interrupt.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>} params    - Tournament parameters.
 * @param {SpeculateContinuationFrame}         frame     - Current tournament continuation frame.
 * @param {UnparkBranchContext<THandle>}       unparkCtx - Target branch index, handle, and persistence callback.
 *
 * @returns {Promise<UnparkBranchResult>} Unpark result.
 */
export async function unparkEscalatedTournamentBranch<THandle = unknown>(params: SpeculateTournamentParams<THandle>, frame: SpeculateContinuationFrame, unparkCtx: UnparkBranchContext<THandle>): Promise<UnparkBranchResult> {
  const runStep = params.executeChildStep ?? ((cNode, cIn, cCtx) => executeDefaultForkOrTournamentChild(cNode, cIn, { childCtx: cCtx, ledgerStore: params.ledgerStore, lessonStore: params.lessonStore, lockManager: params.lockManager, continuationQueue: params.continuationQueue, humanAdaptersById: params.humanAdaptersById, outerFrames: [...params.outerFrames, frame] }));
  const branch = frame.branches.find((b) => b.branchIndex === unparkCtx.branchIndex);
  if (branch === undefined) throw new Error(`Parked branch '${String(unparkCtx.branchIndex)}' not found.`);
  const interruptId = branch.parkedInterruptId ?? 'unknown';
  const payload = branch.parkedEscalationPayloadJson !== undefined ? JSON.parse(branch.parkedEscalationPayloadJson) : undefined;
  const workerAgent = params.capability.workerExecutable.type === 'harness:agent' ? params.capability.workerExecutable : params.capability.workerExecutable.actStep.actor;
  let matchedAsk: Extract<(typeof workerAgent.onInterruptHandlers)[number], { readonly mode: 'ask' }> | undefined;
  for (const h of workerAgent.onInterruptHandlers) {
    if (h.mode === 'ask' && h.interrupt.id === interruptId && matchedAsk === undefined) matchedAsk = h;
    if (h.mode !== 'adjudicate' || matchedAsk !== undefined) continue;
    for (const nh of h.onInterruptHandlers) if (nh.mode === 'ask' && nh.interrupt.id === interruptId && matchedAsk === undefined) matchedAsk = nh;
  }
  const escCap = workerAgent.capabilities?.escalations.find((e) => e.interrupt.id === interruptId) ?? matchedAsk;
  if (escCap === undefined) return Object.freeze({ status: 'aborted-on-child-interrupt', updatedFrame: frame, abortResultJson: JSON.stringify({ status: 'ABORTED_ON_CHILD_INTERRUPT', branchIndex: branch.branchIndex, interruptId, payload }) });
  const requestId = `spec-esc:${params.ctx.runId}:${params.callId}:${String(branch.branchIndex)}:${String(frame.humanRulingsHistory.length)}`;
  const stackWithReqId = branch.continuationStack.map((f) => f.kind === 'agent-frame' ? Object.freeze<AgentContinuationFrame>({ ...f, pauseState: Object.freeze({ kind: 'adjudication', pendingToolBatch: f.pauseState.kind === 'tool-batch' ? f.pauseState.pendingToolBatch : undefined, pendingAdjudication: Object.freeze({ interruptId, interruptPayloadJson: branch.parkedEscalationPayloadJson ?? 'null', humanRequestId: requestId }) }) }) : f);
  const frameWithReq = Object.freeze<SpeculateContinuationFrame>({ ...frame, branches: Object.freeze(frame.branches.map((b) => b.branchIndex === branch.branchIndex ? Object.freeze<SpeculateBranchEntryRecord>({ ...b, continuationStack: Object.freeze(stackWithReqId) }) : b)) });
  await unparkCtx.persistFrame(frameWithReq);
  const humanAdapter = params.humanAdaptersById?.get(escCap.human.id);
  if (humanAdapter === undefined) throw new Error(`No HumanAdapter registered for '${escCap.human.id}'.`);
  const decision = await humanAdapter.requestDecision({ runId: params.ctx.runId, requestId, humanId: escCap.human.id, payload, responseSchema: escCap.responseSchema, signal: params.ctx.signal });
  const grantedLease = escCap.elevateLeaseWhen !== undefined && escCap.elevateLeaseWhen.predicate(decision) ? escCap.elevateLeaseWhen.leaseMapper(decision) : undefined;
  const feedback = 'resumeWith' in escCap && typeof escCap.resumeWith === 'function' ? escCap.resumeWith(decision) : JSON.stringify(decision);
  const req = params.capability.requestSchema.parse(JSON.parse(params.argsJson || '{}'));
  const branchInputs = params.capability.mapBranches(params.parentInput, req);
  const resumedStack = stackWithReqId.map((f) => {
    if (f.kind === 'loop-frame') return grantedLease !== undefined ? Object.freeze<LoopContinuationFrame>({ ...f, grantedLoopLeases: Object.freeze([...f.grantedLoopLeases, grantedLease]) }) : f;
    if (f.kind !== 'agent-frame') return f;
    const prevBatch = f.pauseState.kind === 'adjudication' ? f.pauseState.pendingToolBatch : undefined;
    const nextBatch = prevBatch !== undefined ? (prevBatch.remainingCalls[0]?.blockedPreFlight === true ? Object.freeze({ ...prevBatch, adjudicationFeedback: feedback, remainingCalls: Object.freeze(prevBatch.remainingCalls.map((c, idx) => idx === 0 ? Object.freeze({ ...c, blockedPreFlight: undefined, adjudicatedClauseIds: undefined }) : c)) }) : prevBatch.remainingCalls[0] !== undefined ? Object.freeze({ ...prevBatch, completedResults: Object.freeze([...prevBatch.completedResults, Object.freeze({ callId: prevBatch.remainingCalls[0].callId, content: feedback, isError: false })]), remainingCalls: Object.freeze(prevBatch.remainingCalls.slice(1)) }) : prevBatch) : undefined;
    return Object.freeze<AgentContinuationFrame>({ ...f, activeLeases: grantedLease !== undefined ? Object.freeze([...f.activeLeases, grantedLease]) : f.activeLeases, pauseState: nextBatch !== undefined ? Object.freeze({ kind: 'tool-batch', pendingToolBatch: nextBatch }) : Object.freeze({ kind: 'active-turn' }) });
  });
  const parentRt = (params.ctx as { readonly _runtime?: Record<string, unknown> })._runtime ?? {};
  const outcome = await runStep(params.capability.workerExecutable, branchInputs[branch.branchIndex], Object.freeze({ ...params.ctx, stepExecId: `${params.ctx.stepExecId}:branch:${String(branch.branchIndex)}`, scopeHandle: unparkCtx.handle, activeLeases: grantedLease !== undefined ? Object.freeze([...params.ctx.activeLeases, grantedLease]) : params.ctx.activeLeases, resumeContinuationStack: resumedStack, _runtime: { ...parentRt, outerFrames: [...params.outerFrames, Object.freeze<SpeculateContinuationFrame>({ ...frameWithReq, phase: 'ARBITRATING' })] } }));
  const receipt = await params.branchableScope.inspect(unparkCtx.handle);
  const updatedBranch: SpeculateBranchEntryRecord = outcome.status === 'completed' ? Object.freeze<SpeculateBranchEntryRecord>({ ...branch, status: 'COMPLETED', outputJson: JSON.stringify(outcome.output ?? null), scopeReceiptJson: JSON.stringify(receipt), continuationStack: outcome.continuationStack }) : Object.freeze<SpeculateBranchEntryRecord>({ ...branch, status: 'PARKED_ON_ESCALATION', parkedInterruptId: outcome.interruptId, parkedEscalationPayloadJson: JSON.stringify(outcome.interruptPayload ?? null), continuationStack: outcome.continuationStack });
  const ruling: SpeculateHumanRulingRecord = Object.freeze({ branchIndex: branch.branchIndex, interruptId, rulingSummary: JSON.stringify(decision) });
  const nextBuffered = outcome.status === 'completed' ? mergeBranchBufferedOutcomes(frameWithReq.bufferedLessonOutcomes, branch.branchIndex, outcome.accumulatedLessonOutcomes) : frameWithReq.bufferedLessonOutcomes;
  const nextFrame = Object.freeze<SpeculateContinuationFrame>({ ...frameWithReq, bufferedLessonOutcomes: nextBuffered, branches: Object.freeze(frameWithReq.branches.map((b) => b.branchIndex === branch.branchIndex ? updatedBranch : b)), humanRulingsHistory: Object.freeze([...frameWithReq.humanRulingsHistory, ruling]) });
  await unparkCtx.persistFrame(nextFrame);
  return Object.freeze({ status: 'resumed', updatedFrame: nextFrame });
}

/**
 * Executes optional `.refineWinnerWhen()` while losing worktrees remain mounted, commits the winner with conflict-bounce retries, releases all handles, and flushes winner lessons (`SPEC.md` §3.7.2).
 *
 * Persists `WINNER_COMMITTED` before calling `LessonStore.recordOutcomes()` and discards losing branch lessons.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>}     params    - Tournament parameters.
 * @param {SpeculateContinuationFrame}             frame     - Current tournament continuation frame.
 * @param {WinnerRefinementCommitContext<THandle>} commitCtx - Winner index, verdict, handles, and persistence callback.
 *
 * @returns {Promise<SpeculateTournamentResult>} Final tournament result with committed winner output and receipt.
 */
export async function executeWinnerRefinementAndCommit<THandle = unknown>(params: SpeculateTournamentParams<THandle>, frame: SpeculateContinuationFrame, commitCtx: WinnerRefinementCommitContext<THandle>): Promise<SpeculateTournamentResult> {
  const runStep = params.executeChildStep ?? ((cNode, cIn, cCtx) => executeDefaultForkOrTournamentChild(cNode, cIn, { childCtx: cCtx, ledgerStore: params.ledgerStore, lessonStore: params.lessonStore, lockManager: params.lockManager, continuationQueue: params.continuationQueue, humanAdaptersById: params.humanAdaptersById, outerFrames: [...params.outerFrames, frame] }));
  const winnerHandle = commitCtx.handlesByBranch.get(commitCtx.winnerBranchIndex);
  let winnerBranch = frame.branches.find((b) => b.branchIndex === commitCtx.winnerBranchIndex);
  let curFrame = Object.freeze<SpeculateContinuationFrame>({ ...frame, winnerBranchIndex: commitCtx.winnerBranchIndex });
  if (winnerHandle === undefined || winnerBranch === undefined) throw new Error(`Winning branch '${String(commitCtx.winnerBranchIndex)}' handle not found.`);
  const req = params.capability.requestSchema.parse(JSON.parse(params.argsJson || '{}'));
  const branchInputs = params.capability.mapBranches(params.parentInput, req);
  const refineCfg = params.capability.refineWinnerWhen;
  let activeExecutable = params.capability.workerExecutable;
  let activeInput: unknown = branchInputs[commitCtx.winnerBranchIndex];
  const inheritedLeases = winnerBranch.continuationStack.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame')?.grantedLoopLeases ?? winnerBranch.continuationStack.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame')?.activeLeases ?? params.ctx.activeLeases;
  try {
    if (refineCfg !== undefined && commitCtx.verdict !== undefined && refineCfg.predicate(commitCtx.verdict)) {
      const preCkpt = await params.branchableScope.serializeCheckpoint(winnerHandle);
      await commitCtx.persistFrame((curFrame = Object.freeze<SpeculateContinuationFrame>({ ...curFrame, phase: 'REFINING_WINNER', preRefinementCheckpoint: preCkpt })));
      const candidates = curFrame.branches.map((b) => ({ branchIndex: b.branchIndex, input: branchInputs[b.branchIndex], status: b.status, output: b.outputJson !== undefined ? JSON.parse(b.outputJson) : undefined, scopeReceipt: b.scopeReceiptJson !== undefined ? JSON.parse(b.scopeReceiptJson) : undefined }));
      const refineInput = refineCfg.mapInput(params.parentInput, commitCtx.verdict, candidates);
      const parentRt = (params.ctx as { readonly _runtime?: Record<string, unknown> })._runtime ?? {};
      try {
        const refinedOut = await runStep(refineCfg.refinementExecutable, refineInput, Object.freeze({ ...params.ctx, stepExecId: `${params.ctx.stepExecId}:refine:${String(commitCtx.winnerBranchIndex)}`, scopeHandle: winnerHandle, activeLeases: inheritedLeases, candidateHandles: commitCtx.handlesByBranch, _runtime: { ...parentRt, outerFrames: [...params.outerFrames, curFrame] } }));
        if (refinedOut.status === 'completed') {
          winnerBranch = Object.freeze<SpeculateBranchEntryRecord>({ ...winnerBranch, outputJson: JSON.stringify(refinedOut.output ?? null), continuationStack: promoteRefinedWinnerStack(winnerBranch.continuationStack, refinedOut.continuationStack) });
          curFrame = Object.freeze<SpeculateContinuationFrame>({ ...curFrame, bufferedLessonOutcomes: mergeBranchBufferedOutcomes(curFrame.bufferedLessonOutcomes, commitCtx.winnerBranchIndex, refinedOut.accumulatedLessonOutcomes), branches: Object.freeze(curFrame.branches.map((b) => b.branchIndex === commitCtx.winnerBranchIndex && winnerBranch !== undefined ? winnerBranch : b)) });
          ({ refinementExecutable: activeExecutable } = refineCfg);
          activeInput = refineInput;
        } else await params.branchableScope.restoreCheckpoint(winnerHandle, preCkpt);
      } catch {
        await params.branchableScope.restoreCheckpoint(winnerHandle, preCkpt);
      }
    }
    const commitState = await commitWinnerWithConflictBounce({ params, commitCtx, winnerHandle, winnerBranch, curFrame, activeExecutable, activeInput, inheritedLeases, runStep });
    ({ winnerBranch, curFrame } = commitState);
    if (!commitState.committed || commitState.commitRes.status !== 'clean') return Object.freeze<SpeculateTournamentResult>({ toolResultText: JSON.stringify({ status: 'COMMIT_CONFLICT', winnerBranchIndex: commitCtx.winnerBranchIndex, conflictedSummary: commitState.commitRes.status === 'conflict' ? commitState.commitRes.conflictedSummary : 'conflict' }), isError: true, tournamentFrame: curFrame });
    winnerBranch = Object.freeze<SpeculateBranchEntryRecord>({ ...winnerBranch, status: 'WINNER_COMMITTED', scopeReceiptJson: JSON.stringify(commitState.commitRes.data) });
    await commitCtx.persistFrame((curFrame = Object.freeze<SpeculateContinuationFrame>({ ...curFrame, phase: 'COMMITTING', branches: Object.freeze(curFrame.branches.map((b) => b.branchIndex === commitCtx.winnerBranchIndex && winnerBranch !== undefined ? winnerBranch : b)) })));
    curFrame = await flushCommittedWinnerLessons(params, curFrame, commitCtx, activeExecutable);
    return Object.freeze<SpeculateTournamentResult>({ toolResultText: JSON.stringify({ status: 'WINNER_COMMITTED', winnerBranchIndex: commitCtx.winnerBranchIndex, output: JSON.parse(winnerBranch.outputJson ?? 'null'), scopeReceipt: commitState.commitRes.data }), isError: false, tournamentFrame: curFrame });
  } finally {
    const handles = [...commitCtx.handlesByBranch.values()];
    (commitCtx.handlesByBranch as Map<number, THandle>).clear?.();
    for (const h of handles) await params.branchableScope.release(h);
  }
}
