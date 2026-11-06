import type {
  SpeculateBranchEntryRecord,
  SpeculateBufferedLessonOutcomeRecord,
  SpeculateContinuationFrame,
} from '../../ports/speculate-continuation-frame.js';
import {
  executeWinnerRefinementAndCommit,
  resolvePostRaceCases,
  runTournamentArbiterWithGate,
  unparkEscalatedTournamentBranch,
} from './internal/resolve-tournament-race.js';
import type {
  SpeculateTournamentParams,
  SpeculateTournamentResult,
} from './speculate-tournament-params.js';

/**
 * Executes a parallel `.speculate()` tournament across $B$ isolated branch scopes (`SPEC.md` §3.7.2 Capability 2).
 *
 * Races $B$ branch workers in parallel, parks branches hitting exogenous human escalations or upward interrupts
 * as `PARKED_ON_ESCALATION`, evaluates Post-Race Cases 1–4, runs `crossVerifier` and `arbiter` with built-in
 * candidate index validation, supports non-destructive `'unpark-escalation'`, and commits the winning branch.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>} params - Speculative tournament parameters.
 *
 * @returns {Promise<SpeculateTournamentResult>} Tournament tool result and final `SpeculateContinuationFrame`.
 */
export async function executeSpeculateTournament<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
): Promise<SpeculateTournamentResult> {
  const req = params.capability.requestSchema.parse(JSON.parse(params.argsJson || '{}'));
  const branchInputs = params.capability.mapBranches(params.parentInput, req);
  const handlesByBranch = new Map<number, THandle>();
  const bufferedLessons: SpeculateBufferedLessonOutcomeRecord[] = [...(params.existingTournamentFrame?.bufferedLessonOutcomes ?? [])];
  let curFrame: SpeculateContinuationFrame = params.existingTournamentFrame ?? Object.freeze<SpeculateContinuationFrame>({
    kind: 'speculate-frame', parentStepExecId: params.ctx.stepExecId, callId: params.callId, toolName: params.capability.toolName,
    phase: 'RACING', conflictRetryCount: 0, conflictCheckArmed: false, branches: Object.freeze([]), humanRulingsHistory: Object.freeze([]),
  });
  const persistFrame = async (next: SpeculateContinuationFrame): Promise<void> => {
    curFrame = next;
    await params.continuationQueue.enqueueUpdate(params.ctx.stepExecId, () => params.ledgerStore.updateContinuationStack(params.ctx.runId, params.ctx.stepExecId, Object.freeze([...params.outerFrames, next])));
  };
  if (curFrame.branches.length === 0) {
    const settledBranches: SpeculateBranchEntryRecord[] = [];
    for (let idx = 0; idx < params.capability.branchCount; idx += 1) {
      const forkId = `${params.callId}:branch:${String(idx)}`;
      const handle = await params.lockManager.withReadLock(params.ctx.scopeHandle, () => params.branchableScope.forkChild(params.ctx.scopeHandle, forkId));
      handlesByBranch.set(idx, handle);
      try {
        const outcome = await params.executeChildStep(params.capability.workerExecutable, branchInputs[idx], Object.freeze({ ...params.ctx, scopeHandle: handle }));
        const ckpt = await params.branchableScope.serializeCheckpoint(handle);
        if (outcome.status === 'interrupt-raised') {
          settledBranches.push(Object.freeze<SpeculateBranchEntryRecord>({ branchIndex: idx, forkId, status: 'PARKED_ON_ESCALATION', childScopeCheckpoint: ckpt, parkedInterruptId: outcome.interruptId, parkedEscalationPayloadJson: JSON.stringify(outcome.interruptPayload ?? null), continuationStack: outcome.continuationStack }));
        } else {
          const receipt = await params.branchableScope.inspect(handle);
          settledBranches.push(Object.freeze<SpeculateBranchEntryRecord>({ branchIndex: idx, forkId, status: 'COMPLETED', childScopeCheckpoint: ckpt, outputJson: JSON.stringify(outcome.output ?? null), scopeReceiptJson: JSON.stringify(receipt), continuationStack: outcome.continuationStack }));
          if (outcome.accumulatedLessonOutcomes !== undefined) bufferedLessons.push(Object.freeze({ branchIndex: idx, outcomes: Object.freeze(Object.entries(outcome.accumulatedLessonOutcomes).map(([lessonId, lo]) => ({ lessonId, outcome: lo }))) }));
        }
      } catch (err) {
        settledBranches.push(Object.freeze<SpeculateBranchEntryRecord>({ branchIndex: idx, forkId, status: 'FAILED', errorSummary: err instanceof Error ? err.message : String(err), continuationStack: Object.freeze([]) }));
      }
    }
    await persistFrame(Object.freeze<SpeculateContinuationFrame>({ ...curFrame, branches: Object.freeze(settledBranches), bufferedLessonOutcomes: Object.freeze(bufferedLessons) }));
  } else {
    for (const b of curFrame.branches) handlesByBranch.set(b.branchIndex, await params.lockManager.withReadLock(params.ctx.scopeHandle, () => params.branchableScope.reattachChild(params.ctx.scopeHandle, b.forkId, b.childScopeCheckpoint)));
  }
  while (true) {
    const postRace = resolvePostRaceCases(curFrame.branches, curFrame.humanRulingsHistory);
    if (postRace.caseKind === 'all-failed') {
      return Object.freeze<SpeculateTournamentResult>({ toolResultText: JSON.stringify({ status: 'ALL_FAILED', branches: curFrame.branches }), isError: true, tournamentFrame: curFrame });
    }
    if (postRace.caseKind === 'unpark-sole-escalated' && postRace.targetBranchIndex !== undefined) {
      const h = handlesByBranch.get(postRace.targetBranchIndex);
      if (h === undefined) throw new Error(`Missing handle for sole parked branch '${String(postRace.targetBranchIndex)}'.`);
      const unparked = await unparkEscalatedTournamentBranch(params, curFrame, { branchIndex: postRace.targetBranchIndex, handle: h, persistFrame });
      curFrame = unparked.updatedFrame;
      if (unparked.status === 'aborted-on-child-interrupt') return Object.freeze<SpeculateTournamentResult>({ toolResultText: unparked.abortResultJson ?? '{}', isError: false, tournamentFrame: curFrame });
      continue;
    }
    if (postRace.caseKind === 'sole-survivor' && postRace.targetBranchIndex !== undefined) {
      const b = curFrame.branches.find((x) => x.branchIndex === postRace.targetBranchIndex), h = handlesByBranch.get(postRace.targetBranchIndex);
      if (b !== undefined && h !== undefined && params.capability.verifyWinnerWith !== undefined) {
        const vw = params.capability.verifyWinnerWith;
        const evalOut = await params.executeChildStep(vw.evaluator, vw.mapInput(branchInputs[b.branchIndex], JSON.parse(b.outputJson ?? 'null'), JSON.parse(b.scopeReceiptJson ?? '{}')), Object.freeze({ ...params.ctx, scopeHandle: h }));
        if (evalOut.status !== 'completed' || !vw.acceptWhen(evalOut.output)) {
          return Object.freeze<SpeculateTournamentResult>({ toolResultText: JSON.stringify({ status: 'SOLE_SURVIVOR_REJECTED', branchIndex: b.branchIndex }), isError: true, tournamentFrame: curFrame });
        }
      }
      return executeWinnerRefinementAndCommit(params, curFrame, { winnerBranchIndex: postRace.targetBranchIndex, verdict: undefined, handlesByBranch, persistFrame });
    }
    await persistFrame(Object.freeze<SpeculateContinuationFrame>({ ...curFrame, phase: 'ARBITRATING' }));
    const arb = await runTournamentArbiterWithGate(params, curFrame, handlesByBranch);
    if (arb.decision.decision === 'reject-all') {
      return Object.freeze<SpeculateTournamentResult>({ toolResultText: JSON.stringify({ status: 'REJECTED_ALL', rationale: arb.decision.rationale }), isError: true, tournamentFrame: curFrame });
    }
    if (arb.decision.decision === 'unpark-escalation') {
      const h = handlesByBranch.get(arb.decision.parkedBranchIndex);
      if (h === undefined) throw new Error(`Missing handle for parked branch '${String(arb.decision.parkedBranchIndex)}'.`);
      const unparked = await unparkEscalatedTournamentBranch(params, curFrame, { branchIndex: arb.decision.parkedBranchIndex, handle: h, persistFrame });
      curFrame = unparked.updatedFrame;
      if (unparked.status === 'aborted-on-child-interrupt') return Object.freeze<SpeculateTournamentResult>({ toolResultText: unparked.abortResultJson ?? '{}', isError: false, tournamentFrame: curFrame });
      continue;
    }
    return executeWinnerRefinementAndCommit(params, curFrame, { winnerBranchIndex: arb.decision.winnerBranchIndex, verdict: arb.verdict, handlesByBranch, persistFrame });
  }
}
