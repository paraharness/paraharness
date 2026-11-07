import pLimit from 'p-limit';
import type {
  SpeculateBranchEntryRecord,
  SpeculateBufferedLessonOutcomeRecord,
  SpeculateContinuationFrame,
} from '../../ports/speculate-continuation-frame.js';
import { executeDefaultForkOrTournamentChild } from '../fork/internal/run-single-fork-call.js';
import {
  executeWinnerRefinementAndCommit,
  resolvePostRaceCases,
  runTournamentArbiterWithGate,
  unparkEscalatedTournamentBranch,
} from './internal/resolve-tournament-race.js';
import type { SpeculateTournamentParams } from './speculate-tournament-params.js';
import type { SpeculateTournamentResult } from './speculate-tournament-result.js';

/**
 * Forks and races $B$ candidate branches in parallel, or reattaches existing branch handles on crash recovery (`SPEC.md` §3.7.2).
 *
 * Populates `handlesByBranch` and returns the updated `SpeculateContinuationFrame`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>}                        params          - Tournament execution parameters.
 * @param {SpeculateContinuationFrame}                                curFrame        - Current tournament continuation frame.
 * @param {object}                                                    raceCtx         - Branch inputs, handle map, and frame persistence callback.
 *
 * @returns {Promise<SpeculateContinuationFrame>} Settled `SpeculateContinuationFrame` after racing or reattachment.
 */
async function raceOrReattachSpeculateBranches<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  curFrame: SpeculateContinuationFrame,
  raceCtx: {
    readonly branchInputs: readonly unknown[];
    readonly handlesByBranch: Map<number, THandle>;
    readonly runStep: NonNullable<SpeculateTournamentParams<THandle>['executeChildStep']>;
    readonly persistFrame: (next: SpeculateContinuationFrame) => Promise<void>;
  },
): Promise<SpeculateContinuationFrame> {
  const { branchInputs, handlesByBranch, runStep, persistFrame } = raceCtx;
  if (curFrame.branches.length > 0) {
    for (const branch of curFrame.branches) {
      handlesByBranch.set(
        branch.branchIndex,
        await params.lockManager.withReadLock(params.ctx.scopeHandle, () =>
          params.branchableScope.reattachChild(
            params.ctx.scopeHandle,
            branch.forkId,
            branch.childScopeCheckpoint,
          ),
        ),
      );
    }
    return curFrame;
  }
  const bufferedLessons: SpeculateBufferedLessonOutcomeRecord[] = [
    ...(params.existingTournamentFrame?.bufferedLessonOutcomes ?? []),
  ];
  for (let idx = 0; idx < params.capability.branchCount; idx += 1) {
    handlesByBranch.set(
      idx,
      await params.lockManager.withReadLock(params.ctx.scopeHandle, () =>
        params.branchableScope.forkChild(
          params.ctx.scopeHandle,
          `${params.callId}:branch:${String(idx)}`,
        ),
      ),
    );
  }
  const limit = pLimit(Math.max(1, params.capability.branchCount));
  const settledBranches = await Promise.all(
    Array.from({ length: params.capability.branchCount }, (_, idx) =>
      limit(async (): Promise<SpeculateBranchEntryRecord> => {
        const forkId = `${params.callId}:branch:${String(idx)}`;
        const handle = handlesByBranch.get(idx) as THandle;
        try {
          const outcome = await runStep(
            params.capability.workerExecutable,
            branchInputs[idx],
            Object.freeze({
              ...params.ctx,
              stepExecId: `${params.ctx.stepExecId}:branch:${String(idx)}`,
              scopeHandle: handle,
            }),
          );
          const ckpt = await params.branchableScope.serializeCheckpoint(handle);
          if (outcome.status === 'interrupt-raised') {
            return Object.freeze<SpeculateBranchEntryRecord>({
              branchIndex: idx,
              forkId,
              status: 'PARKED_ON_ESCALATION',
              childScopeCheckpoint: ckpt,
              parkedInterruptId: outcome.interruptId,
              parkedEscalationPayloadJson: JSON.stringify(outcome.interruptPayload ?? null),
              continuationStack: outcome.continuationStack,
            });
          }
          const receipt = await params.branchableScope.inspect(handle);
          if (outcome.accumulatedLessonOutcomes !== undefined) {
            bufferedLessons.push(
              Object.freeze({
                branchIndex: idx,
                outcomes: Object.freeze(
                  Object.entries(outcome.accumulatedLessonOutcomes).map(([lessonId, lo]) => ({
                    lessonId,
                    outcome: lo,
                  })),
                ),
              }),
            );
          }
          return Object.freeze<SpeculateBranchEntryRecord>({
            branchIndex: idx,
            forkId,
            status: 'COMPLETED',
            childScopeCheckpoint: ckpt,
            outputJson: JSON.stringify(outcome.output ?? null),
            scopeReceiptJson: JSON.stringify(receipt),
            continuationStack: outcome.continuationStack,
          });
        } catch (err) {
          return Object.freeze<SpeculateBranchEntryRecord>({
            branchIndex: idx,
            forkId,
            status: 'FAILED',
            errorSummary: err instanceof Error ? err.message : String(err),
            continuationStack: Object.freeze([]),
          });
        }
      }),
    ),
  );
  const updatedFrame = Object.freeze<SpeculateContinuationFrame>({
    ...curFrame,
    branches: Object.freeze(settledBranches),
    bufferedLessonOutcomes: Object.freeze(bufferedLessons),
  });
  await persistFrame(updatedFrame);
  return updatedFrame;
}

/**
 * Evaluates `verifyWinnerWith` on the sole-survivor branch (Post-Race Case 3) (`SPEC.md` §3.7.2).
 *
 * Marks the branch `'FAILED'` and returns `false` when `verifyWinnerWith` rejects the survivor.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>} params          - Tournament execution parameters.
 * @param {SpeculateContinuationFrame}         curFrame        - Current tournament continuation frame.
 * @param {object}                             verifyCtx       - Target branch index, inputs, handles, runner, and persister.
 *
 * @returns {Promise<boolean>} True if the sole survivor passed verification (or no verifier is configured).
 */
async function verifySoleSurvivorCandidate<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  curFrame: SpeculateContinuationFrame,
  verifyCtx: {
    readonly targetBranchIndex: number;
    readonly branchInputs: readonly unknown[];
    readonly handlesByBranch: ReadonlyMap<number, THandle>;
    readonly runStep: NonNullable<SpeculateTournamentParams<THandle>['executeChildStep']>;
    readonly persistFrame: (next: SpeculateContinuationFrame) => Promise<void>;
  },
): Promise<boolean> {
  const { targetBranchIndex, branchInputs, handlesByBranch, runStep, persistFrame } = verifyCtx;
  const soleBranch = curFrame.branches.find((x) => x.branchIndex === targetBranchIndex);
  const soleHandle = handlesByBranch.get(targetBranchIndex);
  const verifyWith = params.capability.verifyWinnerWith;
  if (soleBranch === undefined || soleHandle === undefined || verifyWith === undefined) {
    return true;
  }
  const evalOut = await runStep(
    verifyWith.evaluator,
    verifyWith.mapInput(
      branchInputs[soleBranch.branchIndex],
      JSON.parse(soleBranch.outputJson ?? 'null'),
      JSON.parse(soleBranch.scopeReceiptJson ?? '{}'),
    ),
    Object.freeze({
      ...params.ctx,
      stepExecId: `${params.ctx.stepExecId}:verify:${String(soleBranch.branchIndex)}`,
      scopeHandle: soleHandle,
    }),
  );
  if (evalOut.status === 'completed' && verifyWith.acceptWhen(evalOut.output)) {
    return true;
  }
  await persistFrame(
    Object.freeze<SpeculateContinuationFrame>({
      ...curFrame,
      branches: Object.freeze(
        curFrame.branches.map((x) =>
          x.branchIndex === soleBranch.branchIndex
            ? Object.freeze<SpeculateBranchEntryRecord>({
                ...x,
                status: 'FAILED',
                errorSummary: 'Rejected by verifyWinnerWith',
              })
            : x,
        ),
      ),
    }),
  );
  return false;
}

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
  let curFrame: SpeculateContinuationFrame =
    params.existingTournamentFrame ??
    Object.freeze<SpeculateContinuationFrame>({
      kind: 'speculate-frame',
      parentStepExecId: params.ctx.stepExecId,
      callId: params.callId,
      toolName: params.capability.toolName,
      phase: 'RACING',
      conflictRetryCount: 0,
      conflictCheckArmed: false,
      branches: Object.freeze([]),
      humanRulingsHistory: Object.freeze([]),
    });
  const persistFrame = async (next: SpeculateContinuationFrame): Promise<void> => {
    curFrame = next;
    await params.continuationQueue.enqueueUpdate(params.ctx.stepExecId, () =>
      params.ledgerStore.updateContinuationStack(
        params.ctx.runId,
        params.ctx.stepExecId,
        Object.freeze([...params.outerFrames, next]),
      ),
    );
  };
  const runStep =
    params.executeChildStep ??
    ((cNode, cIn, cCtx) =>
      executeDefaultForkOrTournamentChild(cNode, cIn, {
        childCtx: cCtx,
        ledgerStore: params.ledgerStore,
        lessonStore: params.lessonStore,
        lockManager: params.lockManager,
        continuationQueue: params.continuationQueue,
        humanAdaptersById: params.humanAdaptersById,
        outerFrames: [...params.outerFrames, curFrame],
      }));
  const normParams: SpeculateTournamentParams<THandle> = { ...params, executeChildStep: runStep };
  try {
    curFrame = await raceOrReattachSpeculateBranches(normParams, curFrame, {
      branchInputs,
      handlesByBranch,
      runStep,
      persistFrame,
    });
    while (true) {
      const postRace = resolvePostRaceCases(curFrame.branches, curFrame.humanRulingsHistory);
      if (postRace.caseKind === 'all-failed') {
        return Object.freeze<SpeculateTournamentResult>({
          toolResultText: JSON.stringify({ status: 'ALL_FAILED', branches: curFrame.branches }),
          isError: true,
          tournamentFrame: curFrame,
        });
      }
      if (
        postRace.caseKind === 'unpark-sole-escalated' &&
        postRace.targetBranchIndex !== undefined
      ) {
        const unparked = await unparkEscalatedTournamentBranch(normParams, curFrame, {
          branchIndex: postRace.targetBranchIndex,
          handle: handlesByBranch.get(postRace.targetBranchIndex) as THandle,
          persistFrame,
        });
        curFrame = unparked.updatedFrame;
        if (unparked.status === 'aborted-on-child-interrupt') {
          return Object.freeze<SpeculateTournamentResult>({
            toolResultText: unparked.abortResultJson ?? '{}',
            isError: false,
            tournamentFrame: curFrame,
          });
        }
        continue;
      }
      if (postRace.caseKind === 'sole-survivor' && postRace.targetBranchIndex !== undefined) {
        const verified = await verifySoleSurvivorCandidate(normParams, curFrame, {
          targetBranchIndex: postRace.targetBranchIndex,
          branchInputs,
          handlesByBranch,
          runStep,
          persistFrame,
        });
        if (!verified) {
          continue;
        }
        return await executeWinnerRefinementAndCommit(normParams, curFrame, {
          winnerBranchIndex: postRace.targetBranchIndex,
          verdict: undefined,
          handlesByBranch,
          persistFrame,
        });
      }
      await persistFrame(
        Object.freeze<SpeculateContinuationFrame>({ ...curFrame, phase: 'ARBITRATING' }),
      );
      const arb = await runTournamentArbiterWithGate(normParams, curFrame, handlesByBranch);
      if (arb.decision.decision === 'reject-all') {
        return Object.freeze<SpeculateTournamentResult>({
          toolResultText: JSON.stringify({
            status: 'REJECTED_ALL',
            rationale: arb.decision.rationale,
          }),
          isError: true,
          tournamentFrame: curFrame,
        });
      }
      if (arb.decision.decision === 'unpark-escalation') {
        const unparked = await unparkEscalatedTournamentBranch(normParams, curFrame, {
          branchIndex: arb.decision.parkedBranchIndex,
          handle: handlesByBranch.get(arb.decision.parkedBranchIndex) as THandle,
          persistFrame,
        });
        curFrame = unparked.updatedFrame;
        if (unparked.status === 'aborted-on-child-interrupt') {
          return Object.freeze<SpeculateTournamentResult>({
            toolResultText: unparked.abortResultJson ?? '{}',
            isError: false,
            tournamentFrame: curFrame,
          });
        }
        continue;
      }
      return await executeWinnerRefinementAndCommit(normParams, curFrame, {
        winnerBranchIndex: arb.decision.winnerBranchIndex,
        verdict: arb.verdict,
        handlesByBranch,
        persistFrame,
      });
    }
  } finally {
    const handles = [...handlesByBranch.values()];
    handlesByBranch.clear();
    for (const handle of handles) {
      await params.branchableScope.release(handle);
    }
  }
}
