import type { AgentNode } from '../../../ast/agent-node.js';
import type { LoopNode } from '../../../ast/loop-node.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { LeaseDelta } from '../../../ports/lease-delta.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { CrossVerifierBranchCandidate } from '../../../ports/runtime-executor-registry.js';
import type {
  SpeculateBranchEntryRecord,
  SpeculateContinuationFrame,
  SpeculateHumanRulingRecord,
} from '../../../ports/speculate-continuation-frame.js';
import { getStepRuntimeInternals } from '../../agent/internal/get-step-runtime-internals.js';
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
 * Context parameters for `buildArbiterCandidatesAndFailures` and `runTournamentArbiterWithGate`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface RunTournamentArbiterWithGateContextParams<THandle = unknown> {
  /** Live branch handles keyed by `branchIndex`. */
  readonly handlesByBranch: ReadonlyMap<number, THandle>;
  /** Pre-computed branch input payloads (`0..B-1`) from `mapBranches`. */
  readonly branchInputs: readonly unknown[];
}

/**
 * Parameters for `runOptionalWinnerRefinement`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface RunOptionalWinnerRefinementParams<THandle = unknown> {
  /** Tournament parameters. */
  readonly params: SpeculateTournamentParams<THandle>;
  /** Winner refinement and commit context. */
  readonly commitCtx: WinnerRefinementCommitContext<THandle>;
  /** Winning branch scope handle. */
  readonly winnerHandle: THandle;
  /** Winning branch entry record. */
  readonly winnerBranch: SpeculateBranchEntryRecord;
  /** Current tournament continuation frame. */
  readonly curFrame: SpeculateContinuationFrame;
  /** Inherited leases from the winning branch. */
  readonly inheritedLeases: readonly LeaseDelta[];
  /** Child step execution callback. */
  readonly runStep: NonNullable<SpeculateTournamentParams<THandle>['executeChildStep']>;
}

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
  for (const branch of branches) {
    if (branch.status === 'COMPLETED' || branch.status === 'WINNER_COMMITTED') {
      completed.push(branch);
    } else if (branch.status === 'PARKED_ON_ESCALATION') {
      parked.push(branch);
    }
  }
  if (completed.length === 0 && parked.length === 0) {
    return Object.freeze<PostRaceResolution>({ caseKind: 'all-failed' });
  }
  if (completed.length === 0 && parked.length === 1 && humanRulingsHistory.length === 0) {
    return Object.freeze<PostRaceResolution>({
      caseKind: 'unpark-sole-escalated',
      targetBranchIndex: parked[0]?.branchIndex,
    });
  }
  if (completed.length === 1 && parked.length === 0 && humanRulingsHistory.length === 0) {
    return Object.freeze<PostRaceResolution>({
      caseKind: 'sole-survivor',
      targetBranchIndex: completed[0]?.branchIndex,
    });
  }
  return Object.freeze<PostRaceResolution>({ caseKind: 'contested-arbitration' });
}

/**
 * Builds candidate descriptors and failure summaries for `arbiter.actor` (`SPEC.md` §3.7.2).
 *
 * Runs `crossVerifier` over `COMPLETED` branch handles and formats `PARKED_ON_ESCALATION` and `COMPLETED` entries.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>}                 params     - Tournament parameters.
 * @param {SpeculateContinuationFrame}                         frame      - Current tournament continuation frame.
 * @param {RunTournamentArbiterWithGateContextParams<THandle>} arbiterCtx - Live branch handles and pre-computed branch inputs.
 *
 * @returns {Promise<{ readonly candidates: readonly Record<string, unknown>[]; readonly failedBranches: readonly { readonly branchIndex: number; readonly errorSummary: string }[] }>} Formatted arbiter candidates and failed branches.
 */
async function buildArbiterCandidatesAndFailures<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  frame: SpeculateContinuationFrame,
  arbiterCtx: RunTournamentArbiterWithGateContextParams<THandle>,
): Promise<{
  readonly candidates: readonly Record<string, unknown>[];
  readonly failedBranches: readonly {
    readonly branchIndex: number;
    readonly errorSummary: string;
  }[];
}> {
  const { handlesByBranch, branchInputs } = arbiterCtx;
  const crossCandidates: CrossVerifierBranchCandidate<THandle>[] = [];
  for (const branch of frame.branches) {
    const handle = handlesByBranch.get(branch.branchIndex);
    if (branch.status === 'COMPLETED' && handle !== undefined) {
      crossCandidates.push({
        branchIndex: branch.branchIndex,
        scopeHandle: handle,
        scopeReceipt: JSON.parse(branch.scopeReceiptJson ?? '{}') as Record<string, unknown>,
      });
    }
  }
  const cvExec =
    params.capability.crossVerifier !== undefined && crossCandidates.length > 0
      ? params.ctx.registry.crossVerifiers[params.capability.crossVerifier.type]
      : undefined;
  const crossReports: Readonly<Record<number, unknown>> =
    cvExec !== undefined && params.capability.crossVerifier !== undefined
      ? await cvExec(params.capability.crossVerifier as never, crossCandidates, params.ctx as never)
      : {};
  const candidates: Array<Record<string, unknown>> = [];
  const failedBranches: Array<{ readonly branchIndex: number; readonly errorSummary: string }> = [];
  for (const branch of frame.branches) {
    if (branch.status === 'FAILED') {
      failedBranches.push({
        branchIndex: branch.branchIndex,
        errorSummary: branch.errorSummary ?? 'Failed',
      });
      continue;
    }
    const handle = handlesByBranch.get(branch.branchIndex);
    let receipt: unknown = {};
    if (branch.scopeReceiptJson !== undefined) {
      receipt = JSON.parse(branch.scopeReceiptJson);
    } else if (handle !== undefined) {
      receipt = await params.branchableScope.inspect(handle);
    }
    if (branch.status === 'PARKED_ON_ESCALATION') {
      const escPayload =
        branch.parkedEscalationPayloadJson !== undefined
          ? JSON.parse(branch.parkedEscalationPayloadJson)
          : undefined;
      candidates.push({
        status: 'PARKED_ON_ESCALATION',
        branchIndex: branch.branchIndex,
        input: branchInputs[branch.branchIndex],
        scopeReceipt: receipt,
        interruptId: branch.parkedInterruptId ?? 'unknown',
        escalationPayload: escPayload,
        parkedInterruptId: branch.parkedInterruptId,
        parkedEscalationPayload: escPayload,
      });
    } else {
      candidates.push({
        status: 'COMPLETED',
        branchIndex: branch.branchIndex,
        input: branchInputs[branch.branchIndex],
        output: branch.outputJson !== undefined ? JSON.parse(branch.outputJson) : undefined,
        scopeReceipt: receipt,
        crossVerifyReport: crossReports[branch.branchIndex],
        crossVerificationReport: crossReports[branch.branchIndex],
      });
    }
  }
  return { candidates, failedBranches };
}

/**
 * Runs the tournament `crossVerifier` and `arbiter.actor` with built-in `beforeStop` candidate index validation (`SPEC.md` §3.7.2).
 *
 * Verifies that `'select-winner'` references a `COMPLETED` branch and `'unpark-escalation'` references
 * a `PARKED_ON_ESCALATION` branch, bouncing invalid indices up to 2 times.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>}                 params     - Tournament parameters.
 * @param {SpeculateContinuationFrame}                         frame      - Current tournament continuation frame.
 * @param {RunTournamentArbiterWithGateContextParams<THandle>} arbiterCtx - Live branch handles and pre-computed branch inputs.
 *
 * @returns {Promise<ValidatedArbiterTurnResult>} Validated arbiter verdict and decision.
 */
export async function runTournamentArbiterWithGate<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  frame: SpeculateContinuationFrame,
  arbiterCtx: RunTournamentArbiterWithGateContextParams<THandle>,
): Promise<ValidatedArbiterTurnResult> {
  const { handlesByBranch } = arbiterCtx;
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
        outerFrames: [...params.outerFrames, frame],
      }));
  const { candidates, failedBranches } = await buildArbiterCandidatesAndFailures(
    params,
    frame,
    arbiterCtx,
  );
  let validationFeedback: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const out = await runStep(
      params.capability.arbiter.actor,
      {
        parentInput: params.parentInput,
        candidates,
        failedBranches,
        humanRulingsHistory: frame.humanRulingsHistory,
        validationFeedback,
      },
      Object.freeze({
        ...params.ctx,
        stepExecId: `${params.ctx.stepExecId}:arbiter:${String(frame.humanRulingsHistory.length)}:${String(attempt)}`,
        candidateHandles: handlesByBranch,
      }),
    );
    const decision = params.capability.arbiter.resolveDecision(out.output);
    const valid =
      decision.decision === 'reject-all' ||
      (decision.decision === 'select-winner' &&
        frame.branches.some(
          (b) => b.branchIndex === decision.winnerBranchIndex && b.status === 'COMPLETED',
        )) ||
      (decision.decision === 'unpark-escalation' &&
        frame.branches.some(
          (b) =>
            b.branchIndex === decision.parkedBranchIndex && b.status === 'PARKED_ON_ESCALATION',
        ));
    if (valid) {
      return Object.freeze<ValidatedArbiterTurnResult>({ verdict: out.output, decision });
    }
    validationFeedback = `Invalid arbiter candidate index in decision '${decision.decision}'. Select a valid COMPLETED or PARKED_ON_ESCALATION branchIndex.`;
  }
  throw new Error(
    `Tournament arbiter '${params.capability.arbiter.actor.id}' failed candidate index validation after 3 attempts.`,
  );
}

/**
 * Finds the matching `ask` handler or `.escalate()` capability on `workerAgent` for `interruptId`.
 *
 * Returns `undefined` when `interruptId` is an upward child interrupt rather than a human escalation.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {AgentNode<unknown, unknown, THandle>} workerAgent - Worker agent AST node.
 * @param {string}                               interruptId - Raised interrupt identifier.
 *
 * @returns {Extract<(typeof workerAgent.onInterruptHandlers)[number], { readonly mode: 'ask' }> | NonNullable<typeof workerAgent.capabilities>['escalations'][number] | undefined} Matched human escalation descriptor.
 */
function findMatchingWorkerEscalation<THandle = unknown>(
  workerAgent: AgentNode<unknown, unknown, THandle>,
  interruptId: string,
):
  | Extract<(typeof workerAgent.onInterruptHandlers)[number], { readonly mode: 'ask' }>
  | NonNullable<typeof workerAgent.capabilities>['escalations'][number]
  | undefined {
  let matchedAsk:
    | Extract<(typeof workerAgent.onInterruptHandlers)[number], { readonly mode: 'ask' }>
    | undefined;
  for (const handler of workerAgent.onInterruptHandlers) {
    if (handler.mode === 'ask' && handler.interrupt.id === interruptId && matchedAsk === undefined) {
      matchedAsk = handler;
    }
    if (handler.mode !== 'adjudicate' || matchedAsk !== undefined) {
      continue;
    }
    for (const nested of handler.onInterruptHandlers) {
      if (
        nested.mode === 'ask' &&
        nested.interrupt.id === interruptId &&
        matchedAsk === undefined
      ) {
        matchedAsk = nested;
      }
    }
  }
  return (
    workerAgent.capabilities?.escalations.find((e) => e.interrupt.id === interruptId) ?? matchedAsk
  );
}

/**
 * Builds the resumed continuation stack for a parked tournament branch after receiving a human ruling.
 *
 * Attaches `grantedLease` to `loop-frame` and `agent-frame` entries and transitions `adjudication` pause state
 * back to `tool-batch` or `active-turn`.
 *
 * @param {readonly ContinuationFrame[]} stackWithReqId - Parked branch continuation stack with `humanRequestId` attached.
 * @param {string}                       feedback       - Formatted human ruling feedback string.
 * @param {LeaseDelta | undefined}       grantedLease   - Optional elevated lease granted by the human ruling.
 *
 * @returns {readonly ContinuationFrame[]} Resumed continuation stack ready for worker re-invocation.
 */
function buildResumedUnparkContinuationStack(
  stackWithReqId: readonly ContinuationFrame[],
  feedback: string,
  grantedLease: LeaseDelta | undefined,
): readonly ContinuationFrame[] {
  const resumed: ContinuationFrame[] = [];
  for (const f of stackWithReqId) {
    if (f.kind === 'loop-frame') {
      resumed.push(
        grantedLease !== undefined
          ? Object.freeze<LoopContinuationFrame>({
              ...f,
              grantedLoopLeases: Object.freeze([...f.grantedLoopLeases, grantedLease]),
            })
          : f,
      );
      continue;
    }
    if (f.kind !== 'agent-frame') {
      resumed.push(f);
      continue;
    }
    const prevBatch =
      f.pauseState.kind === 'adjudication' ? f.pauseState.pendingToolBatch : undefined;
    let nextBatch = prevBatch;
    const leadingCall = prevBatch?.remainingCalls[0];
    if (prevBatch !== undefined && leadingCall !== undefined) {
      if (leadingCall.blockedPreFlight === true) {
        nextBatch = Object.freeze({
          ...prevBatch,
          adjudicationFeedback: feedback,
          remainingCalls: Object.freeze(
            prevBatch.remainingCalls.map((c, idx) =>
              idx === 0
                ? Object.freeze({
                    ...c,
                    blockedPreFlight: undefined,
                    adjudicatedClauseIds: undefined,
                  })
                : c,
            ),
          ),
        });
      } else {
        nextBatch = Object.freeze({
          ...prevBatch,
          completedResults: Object.freeze([
            ...prevBatch.completedResults,
            Object.freeze({
              callId: leadingCall.callId,
              content: feedback,
              isError: false,
            }),
          ]),
          remainingCalls: Object.freeze(prevBatch.remainingCalls.slice(1)),
        });
      }
    }
    resumed.push(
      Object.freeze<AgentContinuationFrame>({
        ...f,
        activeLeases:
          grantedLease !== undefined
            ? Object.freeze([...f.activeLeases, grantedLease])
            : f.activeLeases,
        pauseState:
          nextBatch !== undefined
            ? Object.freeze({ kind: 'tool-batch', pendingToolBatch: nextBatch })
            : Object.freeze({ kind: 'active-turn' }),
      }),
    );
  }
  return Object.freeze(resumed);
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
 * @param {UnparkBranchContext<THandle>}       unparkCtx - Target branch index, handle, branch inputs, and persistence callback.
 *
 * @returns {Promise<UnparkBranchResult>} Unpark result.
 */
export async function unparkEscalatedTournamentBranch<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  frame: SpeculateContinuationFrame,
  unparkCtx: UnparkBranchContext<THandle>,
): Promise<UnparkBranchResult> {
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
        outerFrames: [...params.outerFrames, frame],
      }));
  const branch = frame.branches.find((b) => b.branchIndex === unparkCtx.branchIndex);
  if (branch === undefined) {
    throw new Error(`Parked branch '${String(unparkCtx.branchIndex)}' not found.`);
  }
  const interruptId = branch.parkedInterruptId ?? 'unknown';
  const payload =
    branch.parkedEscalationPayloadJson !== undefined
      ? JSON.parse(branch.parkedEscalationPayloadJson)
      : undefined;
  const workerAgent =
    params.capability.workerExecutable.type === 'harness:agent'
      ? params.capability.workerExecutable
      : params.capability.workerExecutable.actStep.actor;
  const escCap = findMatchingWorkerEscalation(workerAgent, interruptId);
  if (escCap === undefined) {
    return Object.freeze({
      status: 'aborted-on-child-interrupt',
      updatedFrame: frame,
      abortResultJson: JSON.stringify({
        status: 'ABORTED_ON_CHILD_INTERRUPT',
        branchIndex: branch.branchIndex,
        interruptId,
        payload,
      }),
    });
  }
  const requestId = `spec-esc:${params.ctx.runId}:${params.callId}:${String(branch.branchIndex)}:${String(frame.humanRulingsHistory.length)}`;
  const stackWithReqId = branch.continuationStack.map((f) =>
    f.kind === 'agent-frame'
      ? Object.freeze<AgentContinuationFrame>({
          ...f,
          pauseState: Object.freeze({
            kind: 'adjudication',
            pendingToolBatch:
              f.pauseState.kind === 'tool-batch' ? f.pauseState.pendingToolBatch : undefined,
            pendingAdjudication: Object.freeze({
              interruptId,
              interruptPayloadJson: branch.parkedEscalationPayloadJson ?? 'null',
              humanRequestId: requestId,
            }),
          }),
        })
      : f,
  );
  const frameWithReq = Object.freeze<SpeculateContinuationFrame>({
    ...frame,
    branches: Object.freeze(
      frame.branches.map((b) =>
        b.branchIndex === branch.branchIndex
          ? Object.freeze<SpeculateBranchEntryRecord>({
              ...b,
              continuationStack: Object.freeze(stackWithReqId),
            })
          : b,
      ),
    ),
  });
  await unparkCtx.persistFrame(frameWithReq);
  const humanAdapter = params.humanAdaptersById?.get(escCap.human.id);
  if (humanAdapter === undefined) {
    throw new Error(`No HumanAdapter registered for '${escCap.human.id}'.`);
  }
  const decision = await humanAdapter.requestDecision({
    runId: params.ctx.runId,
    requestId,
    humanId: escCap.human.id,
    payload,
    responseSchema: escCap.responseSchema,
    signal: params.ctx.signal,
  });
  const grantedLease =
    escCap.elevateLeaseWhen !== undefined && escCap.elevateLeaseWhen.predicate(decision)
      ? escCap.elevateLeaseWhen.leaseMapper(decision)
      : undefined;
  const feedback =
    'resumeWith' in escCap && typeof escCap.resumeWith === 'function'
      ? escCap.resumeWith(decision)
      : JSON.stringify(decision);
  const resumedStack = buildResumedUnparkContinuationStack(stackWithReqId, feedback, grantedLease);
  const parentRt = getStepRuntimeInternals(params.ctx) ?? {};
  const outcome = await runStep(
    params.capability.workerExecutable,
    unparkCtx.branchInputs[branch.branchIndex],
    Object.freeze({
      ...params.ctx,
      stepExecId: `${params.ctx.stepExecId}:branch:${String(branch.branchIndex)}`,
      scopeHandle: unparkCtx.handle,
      activeLeases:
        grantedLease !== undefined
          ? Object.freeze([...params.ctx.activeLeases, grantedLease])
          : params.ctx.activeLeases,
      resumeContinuationStack: resumedStack,
      _runtime: {
        ...parentRt,
        outerFrames: [
          ...params.outerFrames,
          Object.freeze<SpeculateContinuationFrame>({ ...frameWithReq, phase: 'ARBITRATING' }),
        ],
      },
    }),
  );
  const receipt = await params.branchableScope.inspect(unparkCtx.handle);
  const updatedBranch: SpeculateBranchEntryRecord =
    outcome.status === 'completed'
      ? Object.freeze<SpeculateBranchEntryRecord>({
          ...branch,
          status: 'COMPLETED',
          outputJson: JSON.stringify(outcome.output ?? null),
          scopeReceiptJson: JSON.stringify(receipt),
          continuationStack: outcome.continuationStack,
        })
      : Object.freeze<SpeculateBranchEntryRecord>({
          ...branch,
          status: 'PARKED_ON_ESCALATION',
          parkedInterruptId: outcome.interruptId,
          parkedEscalationPayloadJson: JSON.stringify(outcome.interruptPayload ?? null),
          continuationStack: outcome.continuationStack,
        });
  const ruling: SpeculateHumanRulingRecord = Object.freeze({
    branchIndex: branch.branchIndex,
    interruptId,
    rulingSummary: JSON.stringify(decision),
  });
  const nextBuffered =
    outcome.status === 'completed'
      ? mergeBranchBufferedOutcomes(
          frameWithReq.bufferedLessonOutcomes,
          branch.branchIndex,
          outcome.accumulatedLessonOutcomes,
        )
      : frameWithReq.bufferedLessonOutcomes;
  const nextFrame = Object.freeze<SpeculateContinuationFrame>({
    ...frameWithReq,
    bufferedLessonOutcomes: nextBuffered,
    branches: Object.freeze(
      frameWithReq.branches.map((b) => (b.branchIndex === branch.branchIndex ? updatedBranch : b)),
    ),
    humanRulingsHistory: Object.freeze([...frameWithReq.humanRulingsHistory, ruling]),
  });
  await unparkCtx.persistFrame(nextFrame);
  return Object.freeze({ status: 'resumed', updatedFrame: nextFrame });
}

/**
 * Executes optional `.refineWinnerWhen()` on the winning branch while losing candidate worktrees remain mounted (`SPEC.md` §3.7.2).
 *
 * Snapshots `preRefinementCheckpoint` before invoking the refiner and restores it if the refiner fails or raises an interrupt.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {RunOptionalWinnerRefinementParams<THandle>} refineParams - Refinement parameters.
 *
 * @returns {Promise<{ readonly winnerBranch: SpeculateBranchEntryRecord; readonly curFrame: SpeculateContinuationFrame; readonly activeExecutable: AgentNode<unknown, unknown, THandle> | LoopNode<unknown, unknown, THandle>; readonly activeInput: unknown }>} Updated winner branch, frame, and active executable/input.
 */
async function runOptionalWinnerRefinement<THandle = unknown>(
  refineParams: RunOptionalWinnerRefinementParams<THandle>,
): Promise<{
  readonly winnerBranch: SpeculateBranchEntryRecord;
  readonly curFrame: SpeculateContinuationFrame;
  readonly activeExecutable:
    | AgentNode<unknown, unknown, THandle>
    | LoopNode<unknown, unknown, THandle>;
  readonly activeInput: unknown;
}> {
  const { params, commitCtx, winnerHandle, inheritedLeases, runStep } = refineParams;
  let { winnerBranch, curFrame } = refineParams;
  let activeExecutable = params.capability.workerExecutable;
  let activeInput: unknown = commitCtx.branchInputs[commitCtx.winnerBranchIndex];
  const refineCfg = params.capability.refineWinnerWhen;
  if (
    refineCfg === undefined ||
    commitCtx.verdict === undefined ||
    !refineCfg.predicate(commitCtx.verdict)
  ) {
    return { winnerBranch, curFrame, activeExecutable, activeInput };
  }
  const preCkpt = await params.branchableScope.serializeCheckpoint(winnerHandle);
  curFrame = Object.freeze<SpeculateContinuationFrame>({
    ...curFrame,
    phase: 'REFINING_WINNER',
    preRefinementCheckpoint: preCkpt,
  });
  await commitCtx.persistFrame(curFrame);
  const candidates = curFrame.branches.map((b) => ({
    branchIndex: b.branchIndex,
    input: commitCtx.branchInputs[b.branchIndex],
    status: b.status,
    output: b.outputJson !== undefined ? JSON.parse(b.outputJson) : undefined,
    scopeReceipt: b.scopeReceiptJson !== undefined ? JSON.parse(b.scopeReceiptJson) : undefined,
  }));
  const refineInput = refineCfg.mapInput(params.parentInput, commitCtx.verdict, candidates);
  const parentRt = getStepRuntimeInternals(params.ctx) ?? {};
  try {
    const refinedOut = await runStep(
      refineCfg.refinementExecutable,
      refineInput,
      Object.freeze({
        ...params.ctx,
        stepExecId: `${params.ctx.stepExecId}:refine:${String(commitCtx.winnerBranchIndex)}`,
        scopeHandle: winnerHandle,
        activeLeases: inheritedLeases,
        candidateHandles: commitCtx.handlesByBranch,
        _runtime: { ...parentRt, outerFrames: [...params.outerFrames, curFrame] },
      }),
    );
    if (refinedOut.status === 'completed') {
      winnerBranch = Object.freeze<SpeculateBranchEntryRecord>({
        ...winnerBranch,
        outputJson: JSON.stringify(refinedOut.output ?? null),
        continuationStack: promoteRefinedWinnerStack(
          winnerBranch.continuationStack,
          refinedOut.continuationStack,
        ),
      });
      curFrame = Object.freeze<SpeculateContinuationFrame>({
        ...curFrame,
        bufferedLessonOutcomes: mergeBranchBufferedOutcomes(
          curFrame.bufferedLessonOutcomes,
          commitCtx.winnerBranchIndex,
          refinedOut.accumulatedLessonOutcomes,
        ),
        branches: Object.freeze(
          curFrame.branches.map((b) =>
            b.branchIndex === commitCtx.winnerBranchIndex ? winnerBranch : b,
          ),
        ),
      });
      activeExecutable = refineCfg.refinementExecutable;
      activeInput = refineInput;
    } else {
      await params.branchableScope.restoreCheckpoint(winnerHandle, preCkpt);
    }
  } catch {
    await params.branchableScope.restoreCheckpoint(winnerHandle, preCkpt);
  }
  return { winnerBranch, curFrame, activeExecutable, activeInput };
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
 * @param {WinnerRefinementCommitContext<THandle>} commitCtx - Winner index, verdict, branch inputs, handles, and persistence callback.
 *
 * @returns {Promise<SpeculateTournamentResult>} Final tournament result with committed winner output and receipt.
 */
export async function executeWinnerRefinementAndCommit<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  frame: SpeculateContinuationFrame,
  commitCtx: WinnerRefinementCommitContext<THandle>,
): Promise<SpeculateTournamentResult> {
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
        outerFrames: [...params.outerFrames, frame],
      }));
  const winnerHandle = commitCtx.handlesByBranch.get(commitCtx.winnerBranchIndex);
  const initialWinnerBranch = frame.branches.find(
    (b) => b.branchIndex === commitCtx.winnerBranchIndex,
  );
  if (winnerHandle === undefined || initialWinnerBranch === undefined) {
    throw new Error(`Winning branch '${String(commitCtx.winnerBranchIndex)}' handle not found.`);
  }
  const initialFrame = Object.freeze<SpeculateContinuationFrame>({
    ...frame,
    winnerBranchIndex: commitCtx.winnerBranchIndex,
  });
  const inheritedLeases =
    initialWinnerBranch.continuationStack.find(
      (f): f is LoopContinuationFrame => f.kind === 'loop-frame',
    )?.grantedLoopLeases ??
    initialWinnerBranch.continuationStack.find(
      (f): f is AgentContinuationFrame => f.kind === 'agent-frame',
    )?.activeLeases ??
    params.ctx.activeLeases;
  try {
    const refined = await runOptionalWinnerRefinement({
      params,
      commitCtx,
      winnerHandle,
      winnerBranch: initialWinnerBranch,
      curFrame: initialFrame,
      inheritedLeases,
      runStep,
    });
    const commitState = await commitWinnerWithConflictBounce({
      params,
      commitCtx,
      winnerHandle,
      winnerBranch: refined.winnerBranch,
      curFrame: refined.curFrame,
      activeExecutable: refined.activeExecutable,
      activeInput: refined.activeInput,
      inheritedLeases,
      runStep,
    });
    let { winnerBranch, curFrame } = commitState;
    if (!commitState.committed || commitState.commitRes.status !== 'clean') {
      return Object.freeze<SpeculateTournamentResult>({
        toolResultText: JSON.stringify({
          status: 'COMMIT_CONFLICT',
          winnerBranchIndex: commitCtx.winnerBranchIndex,
          conflictedSummary:
            commitState.commitRes.status === 'conflict'
              ? commitState.commitRes.conflictedSummary
              : 'conflict',
        }),
        isError: true,
        tournamentFrame: curFrame,
      });
    }
    winnerBranch = Object.freeze<SpeculateBranchEntryRecord>({
      ...winnerBranch,
      status: 'WINNER_COMMITTED',
      scopeReceiptJson: JSON.stringify(commitState.commitRes.data),
    });
    curFrame = Object.freeze<SpeculateContinuationFrame>({
      ...curFrame,
      phase: 'COMMITTING',
      branches: Object.freeze(
        curFrame.branches.map((b) =>
          b.branchIndex === commitCtx.winnerBranchIndex ? winnerBranch : b,
        ),
      ),
    });
    await commitCtx.persistFrame(curFrame);
    curFrame = await flushCommittedWinnerLessons(params, curFrame, {
      commitCtx,
      activeExecutable: refined.activeExecutable,
    });
    return Object.freeze<SpeculateTournamentResult>({
      toolResultText: JSON.stringify({
        status: 'WINNER_COMMITTED',
        winnerBranchIndex: commitCtx.winnerBranchIndex,
        output: JSON.parse(winnerBranch.outputJson ?? 'null'),
        scopeReceipt: commitState.commitRes.data,
      }),
      isError: false,
      tournamentFrame: curFrame,
    });
  } finally {
    const handles = [...commitCtx.handlesByBranch.values()];
    if (commitCtx.handlesByBranch instanceof Map) {
      commitCtx.handlesByBranch.clear();
    }
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
