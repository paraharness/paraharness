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
 * Context parameters for `raceOrReattachSpeculateBranches`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface RaceOrReattachSpeculateBranchesContextParams<THandle = unknown> {
  /** Pre-computed branch input payloads (`0..B-1`) from `mapBranches`. */
  readonly branchInputs: readonly unknown[];
  /** Mutable map accumulating forked or reattached branch handles by `branchIndex`. */
  readonly handlesByBranch: Map<number, THandle>;
  /** Child step execution callback. */
  readonly runStep: NonNullable<SpeculateTournamentParams<THandle>['executeChildStep']>;
  /** Callback persisting an updated `SpeculateContinuationFrame` into `LedgerStore`. */
  readonly persistFrame: (next: SpeculateContinuationFrame) => Promise<void>;
}

/**
 * Context parameters for `verifySoleSurvivorCandidate`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface VerifySoleSurvivorCandidateContextParams<THandle = unknown> {
  /** Zero-based index of the sole surviving branch. */
  readonly targetBranchIndex: number;
  /** Pre-computed branch input payloads (`0..B-1`) from `mapBranches`. */
  readonly branchInputs: readonly unknown[];
  /** Map of candidate branch indices to live scope handles. */
  readonly handlesByBranch: ReadonlyMap<number, THandle>;
  /** Child step execution callback. */
  readonly runStep: NonNullable<SpeculateTournamentParams<THandle>['executeChildStep']>;
  /** Callback persisting an updated `SpeculateContinuationFrame` into `LedgerStore`. */
  readonly persistFrame: (next: SpeculateContinuationFrame) => Promise<void>;
}

/**
 * Looks up a required branch scope handle by `branchIndex`, throwing an actionable error if absent.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ReadonlyMap<number, THandle>} handlesByBranch - Map of branch indices to scope handles.
 * @param {number}                       branchIndex     - Target branch index (`0..B-1`).
 * @param {string}                       callId          - Tournament tool call identifier.
 *
 * @returns {THandle} Resolved branch scope handle.
 *
 * @throws {Error} If `branchIndex` is not present in `handlesByBranch`.
 */
function getRequiredBranchHandle<THandle>(
  handlesByBranch: ReadonlyMap<number, THandle>,
  branchIndex: number,
  callId: string,
): THandle {
  const handle = handlesByBranch.get(branchIndex);
  if (handle === undefined) {
    throw new Error(
      `Missing branch scope handle for branchIndex ${String(branchIndex)} in tournament '${callId}'.`,
    );
  }
  return handle;
}

/**
 * Persists an updated `SpeculateContinuationFrame` into `LedgerStore` via `params.continuationQueue`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>} params    - Tournament execution parameters.
 * @param {SpeculateContinuationFrame}         nextFrame - Updated tournament continuation frame to persist.
 *
 * @returns {Promise<void>} Resolves once the continuation stack is persisted.
 */
async function persistSpeculateContinuationFrame<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  nextFrame: SpeculateContinuationFrame,
): Promise<void> {
  await params.continuationQueue.enqueueUpdate(params.ctx.stepExecId, () =>
    params.ledgerStore.updateContinuationStack(
      params.ctx.runId,
      params.ctx.stepExecId,
      Object.freeze([...params.outerFrames, nextFrame]),
    ),
  );
}

/**
 * Resolves the child step runner for a speculative tournament, defaulting to `executeDefaultForkOrTournamentChild`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>} params       - Tournament execution parameters.
 * @param {SpeculateContinuationFrame}         initialFrame - Initial tournament continuation frame.
 *
 * @returns {NonNullable<SpeculateTournamentParams<THandle>['executeChildStep']>} Child step runner.
 */
function resolveTournamentChildStepRunner<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  initialFrame: SpeculateContinuationFrame,
): NonNullable<SpeculateTournamentParams<THandle>['executeChildStep']> {
  if (params.executeChildStep !== undefined) {
    return params.executeChildStep;
  }
  return (cNode, cIn, cCtx) =>
    executeDefaultForkOrTournamentChild(cNode, cIn, {
      childCtx: cCtx,
      ledgerStore: params.ledgerStore,
      lessonStore: params.lessonStore,
      lockManager: params.lockManager,
      continuationQueue: params.continuationQueue,
      humanAdaptersById: params.humanAdaptersById,
      outerFrames: [...params.outerFrames, initialFrame],
    });
}

/**
 * Forks and races $B$ candidate branches in parallel, or reattaches existing branch handles on crash recovery (`SPEC.md` §3.7.2).
 *
 * Populates `handlesByBranch` and returns the updated `SpeculateContinuationFrame`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>}                      params   - Tournament execution parameters.
 * @param {SpeculateContinuationFrame}                              curFrame - Current tournament continuation frame.
 * @param {RaceOrReattachSpeculateBranchesContextParams<THandle>}   raceCtx  - Branch inputs, handle map, and frame persistence callback.
 *
 * @returns {Promise<SpeculateContinuationFrame>} Settled `SpeculateContinuationFrame` after racing or reattachment.
 */
async function raceOrReattachSpeculateBranches<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  curFrame: SpeculateContinuationFrame,
  raceCtx: RaceOrReattachSpeculateBranchesContextParams<THandle>,
): Promise<SpeculateContinuationFrame> {
  const { branchInputs, handlesByBranch, runStep, persistFrame } = raceCtx;
  if (curFrame.branches.length > 0) {
    for (const branch of curFrame.branches) {
      handlesByBranch.set(
        branch.branchIndex,
        await params.lockManager.withReadLock(
          params.ctx.scopeHandle,
          () =>
            params.branchableScope.reattachChild(
              params.ctx.scopeHandle,
              branch.forkId,
              branch.childScopeCheckpoint,
            ),
          params.ctx.signal,
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
      await params.lockManager.withReadLock(
        params.ctx.scopeHandle,
        () =>
          params.branchableScope.forkChild(
            params.ctx.scopeHandle,
            `${params.callId}:branch:${String(idx)}`,
          ),
        params.ctx.signal,
      ),
    );
  }
  const limit = pLimit(Math.max(1, params.capability.branchCount));
  const settledBranches = await Promise.all(
    Array.from({ length: params.capability.branchCount }, (_, idx) =>
      limit(async (): Promise<SpeculateBranchEntryRecord> => {
        const forkId = `${params.callId}:branch:${String(idx)}`;
        const handle = getRequiredBranchHandle(handlesByBranch, idx, params.callId);
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
            const outcomesMap = outcome.accumulatedLessonOutcomes;
            const pairs: Array<{
              readonly lessonId: string;
              readonly outcome: NonNullable<typeof outcomesMap>[string];
            }> = [];
            for (const lessonId in outcomesMap) {
              if (Object.hasOwn(outcomesMap, lessonId)) {
                const lo = outcomesMap[lessonId];
                if (lo !== undefined) {
                  pairs.push({ lessonId, outcome: lo });
                }
              }
            }
            bufferedLessons.push(
              Object.freeze({
                branchIndex: idx,
                outcomes: Object.freeze(pairs),
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
 * @param {SpeculateTournamentParams<THandle>}                   params    - Tournament execution parameters.
 * @param {SpeculateContinuationFrame}                           curFrame  - Current tournament continuation frame.
 * @param {VerifySoleSurvivorCandidateContextParams<THandle>}    verifyCtx - Target branch index, inputs, handles, runner, and persister.
 *
 * @returns {Promise<{ readonly verified: boolean; readonly updatedFrame: SpeculateContinuationFrame }>} Verification result and updated frame.
 */
async function verifySoleSurvivorCandidate<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  curFrame: SpeculateContinuationFrame,
  verifyCtx: VerifySoleSurvivorCandidateContextParams<THandle>,
): Promise<{ readonly verified: boolean; readonly updatedFrame: SpeculateContinuationFrame }> {
  const { targetBranchIndex, branchInputs, handlesByBranch, runStep, persistFrame } = verifyCtx;
  const soleBranch = curFrame.branches.find((x) => x.branchIndex === targetBranchIndex);
  const soleHandle = handlesByBranch.get(targetBranchIndex);
  const verifyWith = params.capability.verifyWinnerWith;
  if (soleBranch === undefined || soleHandle === undefined || verifyWith === undefined) {
    return { verified: true, updatedFrame: curFrame };
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
    return { verified: true, updatedFrame: curFrame };
  }
  const rejectedFrame = Object.freeze<SpeculateContinuationFrame>({
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
  });
  await persistFrame(rejectedFrame);
  return { verified: false, updatedFrame: rejectedFrame };
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
  const persistFrame = (next: SpeculateContinuationFrame): Promise<void> =>
    persistSpeculateContinuationFrame(params, next);
  const runStep = resolveTournamentChildStepRunner(params, curFrame);
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
          handle: getRequiredBranchHandle(handlesByBranch, postRace.targetBranchIndex, params.callId),
          branchInputs,
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
        const verification = await verifySoleSurvivorCandidate(normParams, curFrame, {
          targetBranchIndex: postRace.targetBranchIndex,
          branchInputs,
          handlesByBranch,
          runStep,
          persistFrame,
        });
        curFrame = verification.updatedFrame;
        if (!verification.verified) {
          continue;
        }
        return await executeWinnerRefinementAndCommit(normParams, curFrame, {
          winnerBranchIndex: postRace.targetBranchIndex,
          verdict: undefined,
          branchInputs,
          handlesByBranch,
          persistFrame,
        });
      }
      curFrame = Object.freeze<SpeculateContinuationFrame>({ ...curFrame, phase: 'ARBITRATING' });
      await persistFrame(curFrame);
      const arb = await runTournamentArbiterWithGate(normParams, curFrame, {
        handlesByBranch,
        branchInputs,
      });
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
          handle: getRequiredBranchHandle(
            handlesByBranch,
            arb.decision.parkedBranchIndex,
            params.callId,
          ),
          branchInputs,
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
        branchInputs,
        handlesByBranch,
        persistFrame,
      });
    }
  } finally {
    const handles = [...handlesByBranch.values()];
    handlesByBranch.clear();
    const settled = await Promise.allSettled(
      handles.map((handle) => params.branchableScope.release(handle)),
    );
    const firstRejected = settled.find(
      (res): res is PromiseRejectedResult => res.status === 'rejected',
    );
    if (firstRejected !== undefined) {
      throw firstRejected.reason;
    }
  }
}
