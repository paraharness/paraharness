import type { AgentNode } from '../../../ast/agent-node.js';
import type { LessonsNode } from '../../../ast/lessons-node.js';
import type { LoopNode } from '../../../ast/loop-node.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { LeaseDelta } from '../../../ports/lease-delta.js';
import type { LessonOutcome } from '../../../ports/lesson-outcome.types.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { ReconcileResult } from '../../../ports/reconcile-result.types.js';
import type {
  SpeculateBranchEntryRecord,
  SpeculateBufferedLessonOutcomeRecord,
  SpeculateContinuationFrame,
} from '../../../ports/speculate-continuation-frame.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import { flushStepLessonOutcomes } from '../../lessons/lesson-distiller-runner.js';
import { mergeLessonOutcomePrecedence } from '../../lessons/lesson-scoring.js';
import { normalizeEvaluatorRollbackStack } from '../../fork/internal/fork-barrier-and-pause.js';
import type { ChildForkExecutionOutcome } from '../../fork/child-fork-execution-outcome.js';
import type { SpeculateTournamentParams } from '../speculate-tournament-params.js';
import type { WinnerRefinementCommitContext } from '../winner-refinement-commit-context.js';

/**
 * Merges `newOutcomes` into `existingBuffered` for `branchIndex` using 4-state `mergeLessonOutcomePrecedence` (`SPEC.md` §3.4.3 & §3.7.2).
 *
 * Guarantees at most one `SpeculateBufferedLessonOutcomeRecord` per `branchIndex` and one deduplicated outcome per `lessonId`.
 *
 * @param {readonly SpeculateBufferedLessonOutcomeRecord[] | undefined} existingBuffered - Prior buffered branch lesson outcomes.
 * @param {number}                                                      branchIndex      - Target branch index (`0..B-1`).
 * @param {Readonly<Record<string, LessonOutcome>> | undefined}         newOutcomes      - Newly accumulated outcomes for `branchIndex`.
 *
 * @returns {readonly SpeculateBufferedLessonOutcomeRecord[]} Updated buffered lesson outcome records.
 */
export function mergeBranchBufferedOutcomes(
  existingBuffered: readonly SpeculateBufferedLessonOutcomeRecord[] | undefined,
  branchIndex: number,
  newOutcomes: Readonly<Record<string, LessonOutcome>> | undefined,
): readonly SpeculateBufferedLessonOutcomeRecord[] {
  const mergedForBranch = new Map<string, LessonOutcome>();
  const otherBranches: SpeculateBufferedLessonOutcomeRecord[] = [];
  for (const record of existingBuffered ?? []) {
    if (record.branchIndex === branchIndex) {
      for (const entry of record.outcomes) {
        mergedForBranch.set(entry.lessonId, mergeLessonOutcomePrecedence(mergedForBranch.get(entry.lessonId), entry.outcome));
      }
    } else {
      otherBranches.push(record);
    }
  }
  if (newOutcomes !== undefined) {
    for (const [lessonId, outcome] of Object.entries(newOutcomes)) {
      mergedForBranch.set(lessonId, mergeLessonOutcomePrecedence(mergedForBranch.get(lessonId), outcome));
    }
  }
  const outcomes: Array<{ readonly lessonId: string; readonly outcome: LessonOutcome }> = [];
  for (const [lessonId, outcome] of mergedForBranch) outcomes.push(Object.freeze({ lessonId, outcome }));
  if (outcomes.length > 0) {
    otherBranches.push(Object.freeze<SpeculateBufferedLessonOutcomeRecord>({ branchIndex, outcomes: Object.freeze(outcomes) }));
  }
  return Object.freeze(otherBranches);
}

/**
 * Promotes `refinedStack` onto the winning branch while preserving pre-refinement `grantedLoopLeases` and `activeLeases` (`SPEC.md` §3.7.2).
 *
 * Ensures conflict-bounce retries after `.refineWinnerWhen()` resume the promoted refiner stack with all prior leases intact.
 *
 * @param {readonly ContinuationFrame[]} priorStack   - Pre-refinement winner continuation stack.
 * @param {readonly ContinuationFrame[]} refinedStack - Completed refiner continuation stack.
 *
 * @returns {readonly ContinuationFrame[]} Promoted continuation stack with inherited leases.
 */
export function promoteRefinedWinnerStack(
  priorStack: readonly ContinuationFrame[],
  refinedStack: readonly ContinuationFrame[],
): readonly ContinuationFrame[] {
  if (refinedStack.length === 0) return priorStack;
  const priorLoopLeases = priorStack.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame')?.grantedLoopLeases ?? [];
  const priorAgentLeases = priorStack.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame')?.activeLeases ?? [];
  const mergeLeases = (a: readonly LeaseDelta[], b: readonly LeaseDelta[]): readonly LeaseDelta[] => {
    const seen = new Set<string>();
    const out: LeaseDelta[] = [];
    for (const l of [...a, ...b]) if (!seen.has(l.id)) out.push((seen.add(l.id), l));
    return Object.freeze(out);
  };
  const hasLoopFrame = refinedStack.some((f) => f.kind === 'loop-frame');
  const mapped = refinedStack.map((f) =>
    f.kind === 'loop-frame'
      ? Object.freeze<LoopContinuationFrame>({ ...f, grantedLoopLeases: mergeLeases(priorLoopLeases, f.grantedLoopLeases) })
      : f.kind === 'agent-frame'
        ? Object.freeze<AgentContinuationFrame>({ ...f, activeLeases: mergeLeases(priorLoopLeases.length > 0 ? priorLoopLeases : priorAgentLeases, f.activeLeases) })
        : f,
  );
  const priorLoop = priorStack.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame');
  return Object.freeze(!hasLoopFrame && priorLoop !== undefined ? [priorLoop, ...mapped] : mapped);
}

/**
 * Commits `winnerHandle` into `parentHandle` with up to 2 conflict-bounce retries while losing candidate worktrees remain mounted (`SPEC.md` §3.7.2).
 *
 * Attaches `getConflictLease`, appends `[COMMIT_CONFLICT]`, rolls back evaluator frames, and re-runs the active winner executable.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {object} ctx - Winner commit and conflict-bounce parameters.
 *
 * @returns {Promise<{ readonly committed: boolean; readonly commitRes: ReconcileResult<unknown>; readonly winnerBranch: SpeculateBranchEntryRecord; readonly curFrame: SpeculateContinuationFrame }>} Settled commit state.
 */
export async function commitWinnerWithConflictBounce<THandle = unknown>(ctx: {
  readonly params: SpeculateTournamentParams<THandle>;
  readonly commitCtx: WinnerRefinementCommitContext<THandle>;
  readonly winnerHandle: THandle;
  readonly winnerBranch: SpeculateBranchEntryRecord;
  readonly curFrame: SpeculateContinuationFrame;
  readonly activeExecutable: AgentNode<unknown, unknown, THandle> | LoopNode<unknown, unknown, THandle>;
  readonly activeInput: unknown;
  readonly inheritedLeases: readonly LeaseDelta[];
  readonly runStep: NonNullable<SpeculateTournamentParams<THandle>['executeChildStep']>;
}): Promise<{ readonly committed: boolean; readonly commitRes: ReconcileResult<unknown>; readonly winnerBranch: SpeculateBranchEntryRecord; readonly curFrame: SpeculateContinuationFrame }> {
  let { winnerBranch, curFrame } = ctx;
  for (;;) {
    const commitRes = await ctx.params.lockManager.withWriteLock(ctx.params.ctx.scopeHandle, () => ctx.params.branchableScope.commitChild(ctx.winnerHandle, ctx.params.ctx.scopeHandle));
    if (commitRes.status === 'clean' || curFrame.conflictRetryCount >= 2) return { committed: commitRes.status === 'clean', commitRes, winnerBranch, curFrame };
    const conflictLease = ctx.params.branchableScope.getConflictLease?.(ctx.winnerHandle);
    const note = `[COMMIT_CONFLICT] ${commitRes.conflictedSummary}`;
    const bounceId = `msg:${winnerBranch.forkId}:conflict:${String(curFrame.conflictRetryCount + 1)}`;
    const prevLeaf = winnerBranch.continuationStack.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame')?.leafMessageId ?? null;
    await ctx.params.ledgerStore.appendMessageFrame(ctx.params.ctx.runId, Object.freeze<WireFrameRecord>({ messageId: bounceId, parentMessageId: prevLeaf, vendorId: ctx.params.modelDriver?.vendorId ?? 'anthropic', rawWireFrame: new TextEncoder().encode(note), canonical: Object.freeze({ role: 'user', visibleText: note }), prefixDigest: ctx.params.wirePrefix?.systemDigest ?? 'unpinned' }));
    const bouncedStack = normalizeEvaluatorRollbackStack(winnerBranch.continuationStack, 'evaluate').map((f) => f.kind === 'agent-frame' ? Object.freeze<AgentContinuationFrame>({ ...f, leafMessageId: bounceId, conflictCheckArmed: true, activeLeases: conflictLease !== undefined ? Object.freeze([...f.activeLeases, conflictLease]) : f.activeLeases }) : f.kind === 'loop-frame' ? Object.freeze<LoopContinuationFrame>({ ...f, preservedActLeafMessageId: bounceId, conflictCheckArmed: true, grantedLoopLeases: conflictLease !== undefined ? Object.freeze([...f.grantedLoopLeases, conflictLease]) : f.grantedLoopLeases }) : f);
    winnerBranch = Object.freeze<SpeculateBranchEntryRecord>({ ...winnerBranch, continuationStack: Object.freeze(bouncedStack) });
    curFrame = Object.freeze<SpeculateContinuationFrame>({ ...curFrame, conflictRetryCount: curFrame.conflictRetryCount + 1, conflictCheckArmed: true, branches: Object.freeze(curFrame.branches.map((b) => b.branchIndex === ctx.commitCtx.winnerBranchIndex ? winnerBranch : b)) });
    await ctx.commitCtx.persistFrame(curFrame);
    const parentRt = (ctx.params.ctx as { readonly _runtime?: Record<string, unknown> })._runtime ?? {};
    const retryOut: ChildForkExecutionOutcome<unknown> = await ctx.runStep(ctx.activeExecutable, ctx.activeInput, Object.freeze({ ...ctx.params.ctx, stepExecId: `${ctx.params.ctx.stepExecId}:conflict:${String(ctx.commitCtx.winnerBranchIndex)}:${String(curFrame.conflictRetryCount)}`, scopeHandle: ctx.winnerHandle, activeLeases: conflictLease !== undefined ? Object.freeze([...ctx.inheritedLeases, conflictLease]) : ctx.inheritedLeases, candidateHandles: ctx.commitCtx.handlesByBranch, resumeContinuationStack: winnerBranch.continuationStack, _runtime: { ...parentRt, outerFrames: [...ctx.params.outerFrames, curFrame] } }));
    winnerBranch = Object.freeze<SpeculateBranchEntryRecord>({ ...winnerBranch, outputJson: JSON.stringify(retryOut.output ?? null), continuationStack: promoteRefinedWinnerStack(winnerBranch.continuationStack, retryOut.continuationStack) });
    curFrame = Object.freeze<SpeculateContinuationFrame>({ ...curFrame, bufferedLessonOutcomes: mergeBranchBufferedOutcomes(curFrame.bufferedLessonOutcomes, ctx.commitCtx.winnerBranchIndex, retryOut.accumulatedLessonOutcomes), branches: Object.freeze(curFrame.branches.map((b) => b.branchIndex === ctx.commitCtx.winnerBranchIndex ? winnerBranch : b)) });
  }
}

/**
 * Deduplicates and flushes buffered lesson outcomes for `winnerBranchIndex` after `WINNER_COMMITTED` (`SPEC.md` §3.4.3 & §3.7.2).
 *
 * Uses `flushStepLessonOutcomes` when a `LessonsNode` is mounted on the active or worker executable, or `recordOutcomes` otherwise.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {SpeculateTournamentParams<THandle>}                             params           - Tournament parameters.
 * @param {SpeculateContinuationFrame}                                     curFrame         - Committed tournament continuation frame.
 * @param {WinnerRefinementCommitContext<THandle>}                         commitCtx        - Winner commit context and persistence callback.
 * @param {AgentNode<unknown, unknown, THandle> | LoopNode<unknown, unknown, THandle>} activeExecutable - Active winner executable node.
 *
 * @returns {Promise<SpeculateContinuationFrame>} Updated frame with `lessonsFlushed: true`.
 */
export async function flushCommittedWinnerLessons<THandle = unknown>(
  params: SpeculateTournamentParams<THandle>,
  curFrame: SpeculateContinuationFrame,
  commitCtx: WinnerRefinementCommitContext<THandle>,
  activeExecutable: AgentNode<unknown, unknown, THandle> | LoopNode<unknown, unknown, THandle>,
): Promise<SpeculateContinuationFrame> {
  if (curFrame.lessonsFlushed === true || params.lessonStore === undefined) return curFrame;
  const dedupedByLessonId = new Map<string, LessonOutcome>();
  for (const entry of curFrame.bufferedLessonOutcomes ?? []) {
    if (entry.branchIndex === commitCtx.winnerBranchIndex) {
      for (const outcomeEntry of entry.outcomes) {
        dedupedByLessonId.set(outcomeEntry.lessonId, mergeLessonOutcomePrecedence(dedupedByLessonId.get(outcomeEntry.lessonId), outcomeEntry.outcome));
      }
    }
  }
  const getLessons = (node: AgentNode<unknown, unknown, THandle> | LoopNode<unknown, unknown, THandle>): LessonsNode | undefined =>
    node.type === 'harness:agent' ? (node.lessons?.recordOutcomes !== false ? node.lessons?.node : undefined) : (node.actStep.actor.lessons?.recordOutcomes !== false ? node.actStep.actor.lessons?.node : undefined);
  const lessonsNode = getLessons(activeExecutable) ?? getLessons(params.capability.workerExecutable);
  if (dedupedByLessonId.size > 0) {
    const dedupedMap: Record<string, LessonOutcome> = {};
    const dedupedList: Array<{ readonly lessonId: string; readonly outcome: LessonOutcome }> = [];
    for (const [lessonId, outcome] of dedupedByLessonId) {
      dedupedMap[lessonId] = outcome;
      dedupedList.push({ lessonId, outcome });
    }
    if (lessonsNode !== undefined) await flushStepLessonOutcomes({ lessonsNode, lessonStore: params.lessonStore, accumulatedOutcomes: dedupedMap });
    else await params.lessonStore.recordOutcomes(dedupedList);
  }
  const flushedFrame = Object.freeze<SpeculateContinuationFrame>({ ...curFrame, lessonsFlushed: true });
  await commitCtx.persistFrame(flushedFrame);
  return flushedFrame;
}
