import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { CrossVerifierBranchCandidate } from '../../../ports/runtime-executor-registry.js';
import type {
  SpeculateBranchEntryRecord,
  SpeculateContinuationFrame,
  SpeculateHumanRulingRecord,
} from '../../../ports/speculate-continuation-frame.js';
import type {
  PostRaceResolution,
  SpeculateTournamentParams,
  SpeculateTournamentResult,
  UnparkBranchContext,
  UnparkBranchResult,
  ValidatedArbiterTurnResult,
  WinnerRefinementCommitContext,
} from '../speculate-tournament-params.js';

/**
 * Classifies a completed speculative tournament race into Post-Race Cases 1–4 (`SPEC.md` §3.7.2 Capability 2).
 *
 * Never short-circuits the arbiter when $\ge 1$ branch is parkedAlongside a completed branch,
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
  if (completed.length === 0 && parked.length === 0) {
    return Object.freeze<PostRaceResolution>({ caseKind: 'all-failed' });
  }
  if (completed.length === 0 && parked.length === 1 && humanRulingsHistory.length === 0) {
    return Object.freeze<PostRaceResolution>({ caseKind: 'unpark-sole-escalated', targetBranchIndex: parked[0]?.branchIndex });
  }
  if (completed.length === 1 && parked.length === 0 && humanRulingsHistory.length === 0) {
    return Object.freeze<PostRaceResolution>({ caseKind: 'sole-survivor', targetBranchIndex: completed[0]?.branchIndex });
  }
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
export async function runTournamentArbiterWithGate<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  frame: SpeculateContinuationFrame,
  handlesByBranch: ReadonlyMap<number, THandle>,
): Promise<ValidatedArbiterTurnResult> {
  const crossCandidates: CrossVerifierBranchCandidate<THandle>[] = [];
  for (const b of frame.branches) {
    const h = handlesByBranch.get(b.branchIndex);
    if (b.status === 'COMPLETED' && h !== undefined) {
      crossCandidates.push({ branchIndex: b.branchIndex, scopeHandle: h, scopeReceipt: JSON.parse(b.scopeReceiptJson ?? '{}') as Record<string, unknown> });
    }
  }
  let crossReports: Readonly<Record<number, unknown>> = {};
  if (params.capability.crossVerifier !== undefined && crossCandidates.length > 0) {
    const cvExec = params.ctx.registry.crossVerifiers[params.capability.crossVerifier.type];
    if (cvExec !== undefined) crossReports = await cvExec(params.capability.crossVerifier as never, crossCandidates, params.ctx as never);
  }
  const candidates = frame.branches.map((b) => ({ branchIndex: b.branchIndex, status: b.status, output: b.outputJson !== undefined ? JSON.parse(b.outputJson) : undefined, scopeReceipt: b.scopeReceiptJson !== undefined ? JSON.parse(b.scopeReceiptJson) : undefined, crossVerificationReport: crossReports[b.branchIndex], errorSummary: b.errorSummary, parkedInterruptId: b.parkedInterruptId, parkedEscalationPayload: b.parkedEscalationPayloadJson !== undefined ? JSON.parse(b.parkedEscalationPayloadJson) : undefined }));
  let validationFeedback: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const arbiterInput = { parentInput: params.parentInput, candidates, humanRulingsHistory: frame.humanRulingsHistory, validationFeedback };
    const out = await params.executeChildStep(params.capability.arbiter.actor, arbiterInput, Object.freeze({ ...params.ctx, candidateHandles: handlesByBranch }));
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
export async function unparkEscalatedTournamentBranch<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  frame: SpeculateContinuationFrame,
  unparkCtx: UnparkBranchContext<THandle>,
): Promise<UnparkBranchResult> {
  const branch = frame.branches.find((b) => b.branchIndex === unparkCtx.branchIndex);
  if (branch === undefined) throw new Error(`Parked branch '${String(unparkCtx.branchIndex)}' not found.`);
  const interruptId = branch.parkedInterruptId ?? 'unknown';
  const payload = branch.parkedEscalationPayloadJson !== undefined ? JSON.parse(branch.parkedEscalationPayloadJson) : undefined;
  const workerAgent = params.capability.workerExecutable.type === 'harness:agent' ? params.capability.workerExecutable : params.capability.workerExecutable.actStep.actor;
  const escCap = workerAgent.capabilities?.escalations.find((e) => e.interrupt.id === interruptId);
  if (escCap === undefined) {
    const abortJson = JSON.stringify({ status: 'ABORTED_ON_CHILD_INTERRUPT', branchIndex: branch.branchIndex, interruptId, payload });
    return Object.freeze({ status: 'aborted-on-child-interrupt', updatedFrame: frame, abortResultJson: abortJson });
  }
  const requestId = `spec-esc:${params.ctx.runId}:${params.callId}:${String(branch.branchIndex)}:${String(frame.humanRulingsHistory.length)}`;
  const stackWithReqId = branch.continuationStack.map((f) => f.kind === 'agent-frame' ? Object.freeze<AgentContinuationFrame>({ ...f, pauseState: Object.freeze({ kind: 'adjudication', pendingAdjudication: Object.freeze({ interruptId, interruptPayloadJson: branch.parkedEscalationPayloadJson ?? 'null', humanRequestId: requestId }) }) }) : f);
  const frameWithReq = Object.freeze<SpeculateContinuationFrame>({ ...frame, branches: Object.freeze(frame.branches.map((b) => b.branchIndex === branch.branchIndex ? Object.freeze<SpeculateBranchEntryRecord>({ ...b, continuationStack: Object.freeze(stackWithReqId) }) : b)) });
  await unparkCtx.persistFrame(frameWithReq);
  const humanAdapter = params.humanAdaptersById?.get(escCap.human.id);
  if (humanAdapter === undefined) throw new Error(`No HumanAdapter registered for '${escCap.human.id}'.`);
  const decision = await humanAdapter.requestDecision({ runId: params.ctx.runId, requestId, humanId: escCap.human.id, payload, responseSchema: escCap.responseSchema, signal: params.ctx.signal });
  const grantedLease = escCap.elevateLeaseWhen !== undefined && escCap.elevateLeaseWhen.predicate(decision) ? escCap.elevateLeaseWhen.leaseMapper(decision) : undefined;
  const req = params.capability.requestSchema.parse(JSON.parse(params.argsJson || '{}'));
  const branchInputs = params.capability.mapBranches(params.parentInput, req);
  const outcome = await params.executeChildStep(params.capability.workerExecutable, branchInputs[branch.branchIndex], Object.freeze({ ...params.ctx, scopeHandle: unparkCtx.handle, activeLeases: grantedLease !== undefined ? Object.freeze([...params.ctx.activeLeases, grantedLease]) : params.ctx.activeLeases, resumeContinuationStack: stackWithReqId }));
  const receipt = params.ctx.scope !== undefined ? await params.branchableScope.inspect(unparkCtx.handle) : {};
  const updatedBranch: SpeculateBranchEntryRecord = outcome.status === 'completed' ? Object.freeze<SpeculateBranchEntryRecord>({ ...branch, status: 'COMPLETED', outputJson: JSON.stringify(outcome.output ?? null), scopeReceiptJson: JSON.stringify(receipt), continuationStack: outcome.continuationStack }) : Object.freeze<SpeculateBranchEntryRecord>({ ...branch, status: 'PARKED_ON_ESCALATION', parkedInterruptId: outcome.interruptId, parkedEscalationPayloadJson: JSON.stringify(outcome.interruptPayload ?? null), continuationStack: outcome.continuationStack });
  const ruling: SpeculateHumanRulingRecord = Object.freeze({ branchIndex: branch.branchIndex, interruptId, rulingSummary: JSON.stringify(decision) });
  const nextFrame = Object.freeze<SpeculateContinuationFrame>({ ...frameWithReq, branches: Object.freeze(frameWithReq.branches.map((b) => b.branchIndex === branch.branchIndex ? updatedBranch : b)), humanRulingsHistory: Object.freeze([...frameWithReq.humanRulingsHistory, ruling]) });
  await unparkCtx.persistFrame(nextFrame);
  return Object.freeze({ status: 'resumed', updatedFrame: nextFrame });
}

/**
 * Executes optional `.refineWinnerWhen()` while losing worktrees remain mounted, commits the winner, and flushes winner lessons (`SPEC.md` §3.7.2).
 *
 * Persists `WINNER_COMMITTED` before calling `LessonStore.recordOutcomes()` and discards losing branch lessons.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>}       params    - Tournament parameters.
 * @param {SpeculateContinuationFrame}               frame     - Current tournament continuation frame.
 * @param {WinnerRefinementCommitContext<THandle>}   commitCtx - Winner index, verdict, handles, and persistence callback.
 *
 * @returns {Promise<SpeculateTournamentResult>} Final tournament result with committed winner output and receipt.
 */
export async function executeWinnerRefinementAndCommit<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  frame: SpeculateContinuationFrame,
  commitCtx: WinnerRefinementCommitContext<THandle>,
): Promise<SpeculateTournamentResult> {
  const winnerHandle = commitCtx.handlesByBranch.get(commitCtx.winnerBranchIndex);
  let winnerBranch = frame.branches.find((b) => b.branchIndex === commitCtx.winnerBranchIndex);
  if (winnerHandle === undefined || winnerBranch === undefined) throw new Error(`Winning branch '${String(commitCtx.winnerBranchIndex)}' handle not found.`);
  let curFrame = Object.freeze<SpeculateContinuationFrame>({ ...frame, winnerBranchIndex: commitCtx.winnerBranchIndex });
  const refineCfg = params.capability.refineWinnerWhen;
  if (refineCfg !== undefined && commitCtx.verdict !== undefined && refineCfg.predicate(commitCtx.verdict)) {
    const preCkpt = await params.branchableScope.serializeCheckpoint(winnerHandle);
    curFrame = Object.freeze<SpeculateContinuationFrame>({ ...curFrame, phase: 'REFINING_WINNER', preRefinementCheckpoint: preCkpt });
    await commitCtx.persistFrame(curFrame);
    const candidates = curFrame.branches.map((b) => ({ branchIndex: b.branchIndex, status: b.status, output: b.outputJson !== undefined ? JSON.parse(b.outputJson) : undefined, scopeReceipt: b.scopeReceiptJson !== undefined ? JSON.parse(b.scopeReceiptJson) : undefined }));
    const refineInput = refineCfg.mapInput(params.parentInput, commitCtx.verdict, candidates);
    const refinedOut = await params.executeChildStep(refineCfg.refinementExecutable, refineInput, Object.freeze({ ...params.ctx, scopeHandle: winnerHandle, candidateHandles: commitCtx.handlesByBranch }));
    if (refinedOut.status === 'completed') {
      winnerBranch = Object.freeze<SpeculateBranchEntryRecord>({ ...winnerBranch, outputJson: JSON.stringify(refinedOut.output ?? null) });
      curFrame = Object.freeze<SpeculateContinuationFrame>({ ...curFrame, branches: Object.freeze(curFrame.branches.map((b) => b.branchIndex === commitCtx.winnerBranchIndex && winnerBranch !== undefined ? winnerBranch : b)) });
    }
  }
  const commitRes = await params.lockManager.withWriteLock(params.ctx.scopeHandle, () => params.branchableScope.commitChild(winnerHandle, params.ctx.scopeHandle));
  if (commitRes.status !== 'clean') {
    const failJson = JSON.stringify({ status: 'COMMIT_CONFLICT', winnerBranchIndex: commitCtx.winnerBranchIndex, conflictedSummary: commitRes.conflictedSummary });
    return Object.freeze<SpeculateTournamentResult>({ toolResultText: failJson, isError: true, tournamentFrame: curFrame });
  }
  winnerBranch = Object.freeze<SpeculateBranchEntryRecord>({ ...winnerBranch, status: 'WINNER_COMMITTED', scopeReceiptJson: JSON.stringify(commitRes.data) });
  curFrame = Object.freeze<SpeculateContinuationFrame>({ ...curFrame, phase: 'COMMITTING', branches: Object.freeze(curFrame.branches.map((b) => b.branchIndex === commitCtx.winnerBranchIndex && winnerBranch !== undefined ? winnerBranch : b)) });
  await commitCtx.persistFrame(curFrame);
  if (curFrame.lessonsFlushed !== true && params.lessonStore !== undefined) {
    const winnerLessons = curFrame.bufferedLessonOutcomes?.find((l) => l.branchIndex === commitCtx.winnerBranchIndex);
    if (winnerLessons !== undefined && winnerLessons.outcomes.length > 0) await params.lessonStore.recordOutcomes(winnerLessons.outcomes);
    curFrame = Object.freeze<SpeculateContinuationFrame>({ ...curFrame, lessonsFlushed: true });
    await commitCtx.persistFrame(curFrame);
  }
  const resultJson = JSON.stringify({ status: 'WINNER_COMMITTED', winnerBranchIndex: commitCtx.winnerBranchIndex, output: JSON.parse(winnerBranch.outputJson ?? 'null'), scopeReceipt: commitRes.data });
  return Object.freeze<SpeculateTournamentResult>({ toolResultText: resultJson, isError: false, tournamentFrame: curFrame });
}
