import type { CheckASTNode } from '../../../ast/domain-ast.types.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { IsolationScope } from '../../../ports/isolation-scope.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import { runContrastiveLessonDistillation } from '../../lessons/lesson-distiller-runner.js';
import { mergeLessonOutcomePrecedence } from '../../lessons/lesson-scoring.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import type { BeforeStopGateEvaluationResult } from '../before-stop-gate-evaluation-result.js';

/**
 * Collects `enforceBeforeStopChecks` from `ScopedRuleNode` entries whose `rule.id` is in `injectedScopedRuleIds` (`SPEC.md` §3.4.1).
 *
 * Returns an empty array unless `session.agentFrame.observedEffects` contains at least one
 * effect with `mutatesScope === true`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 *
 * @returns {readonly CheckASTNode<THandle>[]} Triggered scoped-rule `beforeStop` checks.
 */
export function collectTriggeredScopedRuleChecks<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
): readonly CheckASTNode<THandle>[] {
  const hasScopeMutation = session.agentFrame.observedEffects.some(
    (e) => e.mutatesScope === true,
  );
  if (!hasScopeMutation) {
    return Object.freeze([]);
  }
  const injectedRuleIdSet = new Set(session.agentFrame.injectedScopedRuleIds);
  const checks: CheckASTNode<THandle>[] = [];
  for (const rule of session.scopedRules) {
    if (!injectedRuleIdSet.has(rule.id)) {
      continue;
    }
    for (const check of rule.enforceBeforeStopChecks) {
      checks.push(check as CheckASTNode<THandle>);
    }
  }
  return Object.freeze(checks);
}

/**
 * Attributes `gate_rejected_unrecovered` to recalled lessons and snapshots `lastGateFailureJson` under a read lock (`SPEC.md` §3.4.3).
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session          - Active agent turn session state.
 * @param {BeforeStopGateEvaluationResult}            gateResult       - Failed gate evaluation result.
 * @param {unknown}                                   structuredOutput - Candidate structured output from the model.
 *
 * @returns {Promise<void>} Resolves once `lastGateFailureJson` and failed outcomes are recorded on `session.agentFrame`.
 */
export async function recordFailedBeforeStopGate<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  gateResult: BeforeStopGateEvaluationResult,
  structuredOutput: unknown,
): Promise<void> {
  const recordOutcomes = session.node.lessons?.recordOutcomes !== false;
  if (recordOutcomes) {
    for (const l of session.recalledLessons) {
      session.accumulatedLessonOutcomes[l.id] = mergeLessonOutcomePrecedence(
        session.accumulatedLessonOutcomes[l.id],
        'gate_rejected_unrecovered',
      );
    }
  }
  const scopeFactory =
    session.ctx.scopeNode !== undefined
      ? session.ctx.registry.scopes[session.ctx.scopeNode.type]
      : undefined;
  const scopeDriver = (session.ctx.scope ??
    (scopeFactory !== undefined && session.ctx.scopeNode !== undefined
      ? scopeFactory(session.ctx.scopeNode as never, {
          registry: session.ctx.registry,
          resolveEnv: (v) => session.ctx.resolveEnv(v),
          getRunner: (r) => session.ctx.getRunner(r),
        })
      : undefined)) as IsolationScope<THandle, Record<string, unknown>> | undefined;
  const scopeReceipt =
    scopeDriver !== undefined
      ? await session.lockManager.withReadLock(
          session.ctx.scopeHandle,
          () => scopeDriver.inspect(session.ctx.scopeHandle),
          session.ctx.signal,
        )
      : undefined;
  const failSnap = JSON.stringify({
    output: structuredOutput,
    scopeReceipt,
    failedChecks: gateResult.failedCheckIds,
    deficits: gateResult.deficits,
  });
  session.agentFrame = Object.freeze<AgentContinuationFrame>({
    ...session.agentFrame,
    lastGateFailureJson: failSnap,
    accumulatedLessonOutcomes: Object.freeze({ ...session.accumulatedLessonOutcomes }),
  });
}

/**
 * Attributes `violated`, `gate_rejected_recovered`, and `clean_pass` lesson outcomes and triggers `.onGateRecovery()` distillation (`SPEC.md` §3.4.3).
 *
 * Buffers contrastive gate recoveries on `session.agentFrame.bufferedGateRecoveries` when running inside an `H.loop` iteration.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session          - Active agent turn session state.
 * @param {unknown}                                   structuredOutput - Accepted structured output from the model.
 *
 * @returns {Promise<void>} Resolves once passed gate outcomes and any `.onGateRecovery()` distillation complete.
 */
export async function recordPassedBeforeStopGateAndDistill<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  structuredOutput: unknown,
): Promise<void> {
  const recordOutcomes = session.node.lessons?.recordOutcomes !== false;
  if (
    recordOutcomes &&
    typeof structuredOutput === 'object' &&
    structuredOutput !== null &&
    '_harnessMeta' in structuredOutput
  ) {
    const meta = (
      structuredOutput as {
        readonly _harnessMeta?: { readonly violatedLessonIds?: readonly string[] };
      }
    )._harnessMeta;
    for (const vid of meta?.violatedLessonIds ?? []) {
      session.accumulatedLessonOutcomes[vid] = mergeLessonOutcomePrecedence(
        session.accumulatedLessonOutcomes[vid],
        'violated',
      );
    }
  }
  const hadPriorFailure = session.agentFrame.lastGateFailureJson !== undefined;
  if (recordOutcomes) {
    for (const l of session.recalledLessons) {
      const prev = session.accumulatedLessonOutcomes[l.id];
      if (hadPriorFailure && (prev === 'gate_rejected_unrecovered' || prev === undefined)) {
        session.accumulatedLessonOutcomes[l.id] = 'gate_rejected_recovered';
      } else if (prev === undefined) {
        session.accumulatedLessonOutcomes[l.id] = 'clean_pass';
      }
    }
  }
  if (
    hadPriorFailure &&
    session.node.lessons?.node.distillation?.onGateRecovery !== undefined &&
    session.lessonStore !== undefined &&
    session.agentFrame.lastGateFailureJson !== undefined
  ) {
    const rejected = JSON.parse(session.agentFrame.lastGateFailureJson) as {
      readonly output: unknown;
      readonly scopeReceipt?: Record<string, unknown>;
      readonly failedChecks?: readonly string[];
      readonly deficits: readonly string[];
    };
    if (session.outerFrames.some((f) => f.kind === 'loop-frame')) {
      const buffered = Object.freeze([
        ...(session.agentFrame.bufferedGateRecoveries ?? []),
        { source: 'gate', rejected, accepted: { output: structuredOutput } },
      ]);
      session.agentFrame = Object.freeze<AgentContinuationFrame>({
        ...session.agentFrame,
        lastGateFailureJson: undefined,
        neutralSyncContinuation: false,
        conflictCheckArmed: false,
        bufferedGateRecoveries: buffered,
        accumulatedLessonOutcomes: Object.freeze({
          ...session.accumulatedLessonOutcomes,
        }),
      });
      return;
    }
    await runContrastiveLessonDistillation({
      lessonsNode: session.node.lessons.node,
      lessonStore: session.lessonStore,
      topologyStore: session.topologyStore,
      trajectory: { source: 'gate', rejected, accepted: { output: structuredOutput } },
      ctx: session.ctx as never,
      poolManager: session.poolManager,
    });
  }
  session.agentFrame = Object.freeze<AgentContinuationFrame>({
    ...session.agentFrame,
    lastGateFailureJson: undefined,
    neutralSyncContinuation: false,
    conflictCheckArmed: false,
    accumulatedLessonOutcomes: Object.freeze({ ...session.accumulatedLessonOutcomes }),
  });
}

/**
 * Evaluates all `beforeStop` gates (`open-fork` gate, `conflictCleanCheck`, `beforeStopChecks`, and triggered scoped-rule checks) (`SPEC.md` §3.4.1 & §3.7.1).
 *
 * Persists `pausedAtPhase: 'BEFORE_STOP_GATE'` before running checks, attributes lesson outcomes,
 * and appends a `[BEFORE_STOP_GATE_REJECTED]` feedback frame when any check fails.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session          - Active agent turn session state.
 * @param {unknown}                                   structuredOutput - Candidate structured output from the model.
 *
 * @returns {Promise<BeforeStopGateEvaluationResult>} Gate evaluation result and deficit list.
 */
export async function evaluateBeforeStopGate<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  structuredOutput: unknown,
): Promise<BeforeStopGateEvaluationResult> {
  session.agentFrame = Object.freeze<AgentContinuationFrame>({
    ...session.agentFrame,
    pausedAtPhase: 'BEFORE_STOP_GATE',
    pauseState: Object.freeze({ kind: 'before-stop-gate' }),
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
  const deficits: string[] = [];
  const failedCheckIds: string[] = [];
  if (session.node.onChildInterruptHandlers.length > 0 && session.ledgerStore !== undefined) {
    const openForks = await session.ledgerStore.getSuspendedForks(session.ctx.runId, {
      parentStepExecId: session.ctx.stepExecId,
    });
    if (openForks.length > 0) {
      failedCheckIds.push('harness:open-suspended-forks');
      const openForkIds = [];
      for (const f of openForks) {
        openForkIds.push(f.suspendedForkId);
      }
      deficits.push(
        `Open suspended child forks must be resolved via resumeFork before stopping: ${openForkIds.join(', ')}.`,
      );
    }
  }
  const scopeNodeObj = session.ctx.scopeNode as
    | { readonly conflictCleanCheck?: CheckASTNode<THandle> }
    | undefined;
  const allChecks: CheckASTNode<THandle>[] = [
    ...(session.agentFrame.conflictCheckArmed === true &&
    scopeNodeObj?.conflictCleanCheck !== undefined
      ? [scopeNodeObj.conflictCleanCheck]
      : []),
    ...session.node.beforeStopChecks,
    ...collectTriggeredScopedRuleChecks(session),
  ];
  for (const checkNode of allChecks) {
    const checkExec = session.ctx.registry.checks[checkNode.type];
    if (checkExec === undefined) {
      throw new Error(
        `No CheckExecutor registered for '${checkNode.type}' in agent '${session.node.id}'.`,
      );
    }
    const res = await session.lockManager.withReadLock(
      session.ctx.scopeHandle,
      () =>
        Promise.resolve(
          checkExec(
            checkNode as never,
            undefined,
            session.ctx as StepExecutionContext<unknown>,
          ),
        ),
      session.ctx.signal,
    );
    if (!res.ok) {
      const checkId =
        'id' in checkNode && typeof checkNode.id === 'string'
          ? checkNode.id
          : checkNode.type;
      failedCheckIds.push(checkId);
      for (const d of res.deficits) {
        deficits.push(`[${checkId}] ${d}`);
      }
    }
  }
  const result = Object.freeze<BeforeStopGateEvaluationResult>({
    passed: deficits.length === 0,
    deficits: Object.freeze(deficits),
    failedCheckIds: Object.freeze(failedCheckIds),
  });
  if (!result.passed) {
    await recordFailedBeforeStopGate(session, result, structuredOutput);
  } else {
    await recordPassedBeforeStopGateAndDistill(session, structuredOutput);
  }
  if (!result.passed && session.ledgerStore !== undefined) {
    const feedbackText = `[BEFORE_STOP_GATE_REJECTED]\n${deficits.join('\n')}`;
    const msgId = `msg:${session.ctx.stepExecId}:gate-fail:${String(session.agentFrame.turnsTaken)}`;
    await session.ledgerStore.appendMessageFrame(
      session.ctx.runId,
      Object.freeze<WireFrameRecord>({
        messageId: msgId,
        parentMessageId: session.agentFrame.leafMessageId,
        vendorId: session.modelNode.vendor,
        rawWireFrame: new TextEncoder().encode(feedbackText),
        canonical: Object.freeze({ role: 'user', visibleText: feedbackText }),
        prefixDigest: session.wirePrefix?.systemDigest ?? 'unpinned',
      }),
    );
    session.agentFrame = Object.freeze<AgentContinuationFrame>({
      ...session.agentFrame,
      leafMessageId: msgId,
      neutralSyncContinuation: false,
      pausedAtPhase: 'TOOL_BOUNDARY',
      pauseState: Object.freeze({ kind: 'active-turn' }),
    });
  }
  return result;
}
