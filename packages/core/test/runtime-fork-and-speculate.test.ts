import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentContinuationFrame, type ForkBatchEntryRecord, type GitWorktreeHandle, H,
  type LoopContinuationFrame, ScopeLockManager, type SpeculateBranchEntryRecord,
  StepContinuationQueue, type StepExecutionContext, type WireFrameRecord, createExecutorRegistry,
  executeAgent, executeForkBatch, executeResumeForkBatch, executeSpeculateTournament, resolvePostRaceCases,
} from '../src/index.js';
import { InMemoryLedgerStore } from './fixtures/in-memory-ledger-store.js';
import { InMemoryLessonStore } from './fixtures/in-memory-lesson-store.js';
import {
  SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE, SAMPLE_CROSS_VERIFIER_NODE, SAMPLE_MODEL_NODE,
} from './fixtures/sample-domain-nodes.constants.js';
import { ScriptedBranchableScope } from './fixtures/scripted-branchable-scope.js';
import { ScriptedHumanAdapter } from './fixtures/scripted-human-adapter.js';
import { ScriptedModelDriver } from './fixtures/scripted-model-driver.js';

function makeBaseCtx<THandle>(runId: string, stepExecId: string, scopeHandle: THandle): StepExecutionContext<THandle> {
  return Object.freeze({
    runId, stepExecId, scopeHandle, activePartitions: ['core'], activeLeases: [], observedEffects: [],
    registry: createExecutorRegistry({}), resolveEnv: () => '', getRunner: () => { throw new Error('unused'); }, recordEffects: () => undefined,
  });
}

describe('Downward .fork() history modes, CHILD_COMMITTED lesson idempotency, and commitChild conflict bounce', () => {
  it('supports shared-prefix-only vs clone-transcript, persists CHILD_COMMITTED before lesson flush, and bounces commitChild conflicts back to .act() with conflictLease', async () => {
    const childWorker = H.agent<GitWorktreeHandle>('child-worker')
      .model(SAMPLE_MODEL_NODE).input(z.object({ subtask: z.string() })).output(z.object({ done: z.string() }));

    const parent = H.agent<GitWorktreeHandle>('parent-agent')
      .model(SAMPLE_MODEL_NODE).input(z.object({ goal: z.string() })).output(z.object({ ok: z.boolean() }))
      .capabilities(($c) =>
        $c.fork('forkShared', childWorker, ($f) =>
          $f.requestSchema(z.object({ subtask: z.string() })).mapInput((_p, req) => req).historyMode('shared-prefix-only'),
        ).fork('forkClone', childWorker, ($f) =>
          $f.requestSchema(z.object({ subtask: z.string() })).mapInput((_p, req) => req).historyMode('clone-transcript'),
        ),
      ).toAST();

    const forkSharedCap = parent.capabilities?.forks.find((f) => f.toolName === 'forkShared');
    const forkCloneCap = parent.capabilities?.forks.find((f) => f.toolName === 'forkClone');
    if (forkSharedCap === undefined || forkCloneCap === undefined) throw new Error('Missing fork capabilities');

    const ledger = new InMemoryLedgerStore();
    await ledger.createOrResumeRun({ runId: 'run-f1', laneId: 'l1', itemKey: 'k1', inputJson: '{}' });
    const parentMsg: WireFrameRecord = Object.freeze({
      messageId: 'msg:parent:1', parentMessageId: null, vendorId: 'anthropic',
      rawWireFrame: new Uint8Array(), canonical: Object.freeze({ role: 'user', visibleText: 'parent context' }), prefixDigest: 'p1',
    });
    await ledger.appendMessageFrame('run-f1', parentMsg);

    const lessonStore = new InMemoryLessonStore([
      Object.freeze({
        id: 'L-fork', partition: 'core', problemPattern: 'p', directive: 'No race', recentOutcomes: Object.freeze([]),
        totalCleanPasses: 1, totalGateRejectedRecovered: 0, totalViolated: 0, totalGateRejectedUnrecovered: 0,
        epochAtCreation: 1, creationRunId: 'r0', creationPartitionEpochs: Object.freeze({ core: 1 }), retired: false,
      }),
    ]);
    let statusAtLessonFlush: string | undefined;
    const origRecordOutcomes = lessonStore.recordOutcomes.bind(lessonStore);
    lessonStore.recordOutcomes = async (outcomes) => {
      const stack = ledger.steps.get('step-p1')?.continuationStack ?? [];
      const fb = stack.find((f) => f.kind === 'fork-batch-frame');
      if (fb?.kind === 'fork-batch-frame') {
        statusAtLessonFlush = fb.forks.find((f) => f.forkId === 'f-clone')?.status;
      }
      return origRecordOutcomes(outcomes);
    };

    await ledger.recordStepStart({ runId: 'run-f1', stepExecId: 'step-p1', stepId: 'p', executableId: 'parent-agent', inputMsgId: null, continuationStack: [] });
    const scope = new ScriptedBranchableScope();
    await scope.acquireRoot('run-f1');

    const modelDriver = new ScriptedModelDriver();
    const seenChildContexts: Array<StepExecutionContext<string>> = [];
    let cloneAttempt = 0;

    const batchRes = await executeForkBatch({
      parentNode: parent as never, parentInput: { goal: 'build' }, parentLeafMessageId: 'msg:parent:1', outerFrames: [],
      forkCalls: [
        { callId: 'c-clone', forkId: 'f-clone', capability: forkCloneCap as never, argsJson: JSON.stringify({ subtask: 's2' }) },
        { callId: 'c-shared', forkId: 'f-shared', capability: forkSharedCap as never, argsJson: JSON.stringify({ subtask: 's1' }) },
      ],
      branchableScope: scope, lockManager: new ScopeLockManager(), continuationQueue: new StepContinuationQueue(),
      ledgerStore: ledger, lessonStore, modelDriver, ctx: makeBaseCtx('run-f1', 'step-p1', 'root:run-f1'),
      executeChildStep: async (_node, _in, childCtx) => {
        seenChildContexts.push(childCtx);
        if (childCtx.scopeHandle.includes('f-shared')) {
          return { status: 'completed', output: { done: 'shared-ok' }, continuationStack: [] };
        }
        cloneAttempt += 1;
        if (cloneAttempt === 1) scope.commitConflictRemainingCount = 1;
        const loopFrame: LoopContinuationFrame = Object.freeze({
          kind: 'loop-frame', loopId: 'child-loop', roleKey: 'child-loop', lastActModelId: 'claude-sonnet-4-20250514',
          stepExecId: 'step-c', loopInputJson: '{}', iteration: 0, phase: 'evaluate', preservedActLeafMessageId: 'msg:act:leaf',
          turnsTaken: 1, costUsd: 0.01, elapsedDurationMs: 10, actTurnsTaken: 1, actCostUsd: 0.01, actElapsedDurationMs: 10,
          grantedLoopLeases: Object.freeze([]), activeSkillIds: Object.freeze([]), activeSkillActivations: Object.freeze({}),
          observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]), recalledLessons: Object.freeze([]), accumulatedLessonOutcomes: Object.freeze({}),
        });
        const agentFrame: AgentContinuationFrame = Object.freeze({
          kind: 'agent-frame', agentId: 'eval-id', roleKey: 'eval-id', modelId: 'claude-sonnet-4-20250514',
          stepExecId: 'step-c', inputJson: '{}', leafMessageId: 'msg:eval:leaf', turnsTaken: 1, costUsd: 0.01, elapsedDurationMs: 10,
          activeLeases: Object.freeze([]), activeSkillIds: Object.freeze([]), activeSkillActivations: Object.freeze({}),
          observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]), pausedAtPhase: 'BEFORE_STOP_GATE', pauseState: Object.freeze({ kind: 'before-stop-gate' }),
        });
        return {
          status: 'completed', output: { done: `clone-attempt-${String(cloneAttempt)}` },
          leafMessageId: 'msg:act:leaf', continuationStack: [loopFrame, agentFrame],
          accumulatedLessonOutcomes: { 'L-fork': 'clean_pass' },
        };
      },
    });

    expect(modelDriver.recordedForks.map((f) => f.ctx.historyMode)).toEqual(['clone-transcript', 'shared-prefix-only']);
    expect(statusAtLessonFlush).toBe('CHILD_COMMITTED');
    expect(cloneAttempt).toBe(2);
    const bounceCtx = seenChildContexts[2];
    expect(bounceCtx?.activeLeases.some((l) => l.id === 'conflict-resolution-lease')).toBe(true);
    const bouncedLoop = bounceCtx?.resumeContinuationStack?.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame');
    const bouncedAgent = bounceCtx?.resumeContinuationStack?.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame');
    expect(bouncedLoop?.phase).toBe('act');
    expect(bouncedLoop?.conflictCheckArmed).toBe(true);
    expect(bouncedAgent?.conflictCheckArmed).toBe(true);
    expect(ledger.frames.get('msg:f-clone:conflict:1')?.canonical.visibleText).toContain('[COMMIT_CONFLICT] Conflict merging');
    expect(JSON.parse(batchRes.toolResultsByCallId.get('c-clone')?.content ?? '{}').output).toEqual({ done: 'clone-attempt-2' });
  });
});

describe('Upward .onChildInterrupt() turn-batch barrier, resumeFork Cases A/B/C, and open-fork beforeStop gate', () => {
  it('coordinates turn-batch barrier (evaluator rollback, cancelDecision, Case B vs Case C), enforces open-fork beforeStop gate, and executes resumeFork Cases A/B/C and abort', async () => {
    const childIntr = H.interrupt('schema-gap', z.object({ reason: z.string() }));
    const childWorker = H.agent<string>('child-worker')
      .model(SAMPLE_MODEL_NODE).input(z.object({ id: z.string() })).output(z.object({ ok: z.boolean() }));

    const parent = H.agent<string>('parent-barrier')
      .model(SAMPLE_MODEL_NODE).input(z.object({ task: z.string() })).output(z.object({ finished: z.boolean() }))
      .capabilities(($c) =>
        $c.fork('runChild', childWorker, ($f) => $f.requestSchema(z.object({ id: z.string() })).mapInput((_p, r) => r)),
      )
      .onChildInterrupt(childIntr, ($ci) => $ci.pauseSiblingForksInPartitions(() => ['core']).suspendAndReturnToParent())
      .toAST();

    const forkCap = parent.capabilities?.forks[0];
    if (forkCap === undefined) throw new Error('Expected forkCap');

    const ledger = new InMemoryLedgerStore();
    await ledger.createOrResumeRun({ runId: 'run-bar', laneId: 'l1', itemKey: 'k1', inputJson: '{}' });
    await ledger.recordStepStart({ runId: 'run-bar', stepExecId: 'step-bar', stepId: 'p', executableId: 'parent-barrier', inputMsgId: null, continuationStack: [] });
    await ledger.appendMessageFrame('run-bar', Object.freeze({
      messageId: 'msg:sib-b:tool', parentMessageId: null, vendorId: 'anthropic',
      rawWireFrame: new Uint8Array(), canonical: Object.freeze({ role: 'tool', visibleText: 'tool-out', toolResults: Object.freeze([{ callId: 'tc1', content: 'ok', isError: false }]) }), prefixDigest: 'p1',
    }));

    const humanAdapter = new ScriptedHumanAdapter();
    const scope = new ScriptedBranchableScope();
    await scope.acquireRoot('run-bar');
    const modelDriver = new ScriptedModelDriver();

    const raisingLoop: LoopContinuationFrame = Object.freeze({
      kind: 'loop-frame', loopId: 'l-raise', roleKey: 'act-worker-role', lastActModelId: 'm1', stepExecId: 's-r', loopInputJson: '{"id":"f-a"}',
      iteration: 0, phase: 'evaluate', preservedActLeafMessageId: 'msg:act-preserved', turnsTaken: 1, costUsd: 0, elapsedDurationMs: 1,
      actTurnsTaken: 1, actCostUsd: 0, actElapsedDurationMs: 1, grantedLoopLeases: Object.freeze([]), activeSkillIds: Object.freeze([]),
      activeSkillActivations: Object.freeze({}), observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]), recalledLessons: Object.freeze([]), accumulatedLessonOutcomes: Object.freeze({}),
    });
    const raisingEvalAgent: AgentContinuationFrame = Object.freeze({
      kind: 'agent-frame', agentId: 'eval-only', roleKey: 'eval-only', modelId: 'm1', stepExecId: 's-r', inputJson: '{"id":"f-a"}',
      leafMessageId: 'msg:eval-leaf', turnsTaken: 1, costUsd: 0, elapsedDurationMs: 1, activeLeases: Object.freeze([]), activeSkillIds: Object.freeze([]),
      activeSkillActivations: Object.freeze({}), observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]), pausedAtPhase: 'TOOL_BOUNDARY', pauseState: Object.freeze({ kind: 'active-turn' }),
    });
    const sibBFrame: AgentContinuationFrame = Object.freeze({
      kind: 'agent-frame', agentId: 'child-worker', roleKey: 'child-worker', modelId: 'm1', stepExecId: 's-b', inputJson: '{"id":"f-b"}',
      leafMessageId: 'msg:sib-b:tool', turnsTaken: 1, costUsd: 0, elapsedDurationMs: 1, activeLeases: Object.freeze([]), activeSkillIds: Object.freeze([]),
      activeSkillActivations: Object.freeze({}), observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]), pausedAtPhase: 'TOOL_BOUNDARY',
      pauseState: Object.freeze({ kind: 'adjudication', pendingAdjudication: Object.freeze({ interruptId: 'h-int', interruptPayloadJson: '{}', humanRequestId: 'req-sib-b-1' }) }),
    });
    const sibCFrame: AgentContinuationFrame = Object.freeze({
      kind: 'agent-frame', agentId: 'child-worker', roleKey: 'child-worker', modelId: 'm1', stepExecId: 's-c', inputJson: '{"id":"f-c"}',
      leafMessageId: 'msg:sib-c:leaf', turnsTaken: 1, costUsd: 0, elapsedDurationMs: 1, activeLeases: Object.freeze([]), activeSkillIds: Object.freeze([]),
      activeSkillActivations: Object.freeze({}), observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]), pausedAtPhase: 'BEFORE_STOP_GATE', pauseState: Object.freeze({ kind: 'before-stop-gate' }),
    });

    await executeForkBatch({
      parentNode: parent as never, parentInput: { task: 'go' }, parentLeafMessageId: null, outerFrames: [],
      forkCalls: [
        { callId: 'c-done', forkId: 'f-done', capability: forkCap as never, argsJson: JSON.stringify({ id: 'f-done' }) },
        { callId: 'c-b', forkId: 'f-b', capability: forkCap as never, argsJson: JSON.stringify({ id: 'f-b' }) },
        { callId: 'c-c', forkId: 'f-c', capability: forkCap as never, argsJson: JSON.stringify({ id: 'f-c' }) },
        { callId: 'c-a', forkId: 'f-a', capability: forkCap as never, argsJson: JSON.stringify({ id: 'f-a' }) },
      ],
      branchableScope: scope, lockManager: new ScopeLockManager(), continuationQueue: new StepContinuationQueue(),
      ledgerStore: ledger, modelDriver, humanAdaptersById: new Map([['h1', humanAdapter]]),
      ctx: makeBaseCtx('run-bar', 'step-bar', 'root:run-bar'),
      executeChildStep: async (_n, rawIn) => {
        const id = (rawIn as { id: string }).id;
        if (id === 'f-done') return { status: 'completed', output: { ok: true }, continuationStack: [] };
        if (id === 'f-b') return { status: 'completed', output: { ok: false }, continuationStack: [sibBFrame] };
        if (id === 'f-c') return { status: 'completed', output: { ok: false }, continuationStack: [sibCFrame] };
        return {
          status: 'interrupt-raised', interruptId: 'schema-gap', interruptPayload: { reason: 'missing col' },
          raisedByPhase: 'evaluate', continuationStack: [raisingLoop, raisingEvalAgent],
        };
      },
    });

    expect(humanAdapter.cancelledRequests.map((r) => r.requestId)).toEqual(['req-sib-b-1']);
    const openForks = await ledger.getSuspendedForks('run-bar', { parentStepExecId: 'step-bar' });
    expect(openForks.map((f) => f.suspendedForkId).sort()).toEqual(['f-a#1', 'f-b#1', 'f-c#1']);

    const rolledA = openForks.find((f) => f.suspendedForkId === 'f-a#1');
    const rolledAgentA = rolledA?.continuationStack.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame');
    expect(rolledAgentA?.agentId).toBe('act-worker-role');
    expect(rolledAgentA?.leafMessageId).toBe('msg:act-preserved');

    const resumedStacks: Array<readonly unknown[]> = [];
    const resumeRes = await executeResumeForkBatch({
      parentNode: parent as never, parentInput: { task: 'go' }, parentLeafMessageId: null, outerFrames: [],
      resumeRequest: { callId: 'rf-1', suspendedForkIds: ['f-a#1', 'f-b#1'], action: 'resume', resolutionSummary: 'Fixed schema' },
      branchableScope: scope, lockManager: new ScopeLockManager(), continuationQueue: new StepContinuationQueue(),
      ledgerStore: ledger, modelDriver, ctx: makeBaseCtx('run-bar', 'step-bar', 'root:run-bar'),
      executeChildStep: async (_n, _in, childCtx) => {
        resumedStacks.push(childCtx.resumeContinuationStack ?? []);
        return { status: 'completed', output: { ok: true }, continuationStack: [] };
      },
    });

    const parsedMulti = JSON.parse(resumeRes.toolResultsByCallId.get('rf-1')?.content ?? '{}') as { action: string; results: Array<{ forkId: string }> };
    expect(parsedMulti.action).toBe('resume');
    expect(parsedMulti.results.map((r) => r.forkId)).toEqual(['f-a', 'f-b']);
    expect(ledger.frames.get('msg:f-a#1:case-a')?.canonical.visibleText).toContain('[INTERRUPT_RESOLVED] Fixed schema');
    expect(ledger.frames.get('msg:sib-b:tool')?.canonical.visibleText).toContain('[SIBLING_INTERRUPT_RESUME] Fixed schema');

    const preSyncedEntry: ForkBatchEntryRecord = Object.freeze({
      forkId: 'f-c', suspendedForkId: 'f-c#1', callId: 'rf-c', toolName: 'runChild', activePartitions: Object.freeze(['core']),
      status: 'RUNNING', conflictRetryCount: 0, conflictCheckArmed: false, suspensionEpoch: 1,
      syncedToParentCheckpoint: 'ckpt:already-synced', syncResultJson: '{"status":"clean"}',
      continuationStack: Object.freeze([sibCFrame]),
    });
    const restoresBeforeC = scope.restoredCheckpoints.length;
    await executeResumeForkBatch({
      parentNode: parent as never, parentInput: { task: 'go' }, parentLeafMessageId: null, outerFrames: [],
      existingBatchFrame: { kind: 'fork-batch-frame', parentStepExecId: 'step-bar', forks: [preSyncedEntry] },
      resumeRequest: { callId: 'rf-c', suspendedForkIds: ['f-c#1'], action: 'resume', resolutionSummary: 'Reverify C' },
      branchableScope: scope, lockManager: new ScopeLockManager(), continuationQueue: new StepContinuationQueue(),
      ledgerStore: ledger, modelDriver, ctx: makeBaseCtx('run-bar', 'step-bar', 'root:run-bar'),
      executeChildStep: async (_n, _in, childCtx) => {
        resumedStacks.push(childCtx.resumeContinuationStack ?? []);
        return { status: 'completed', output: { ok: true }, continuationStack: [] };
      },
    });
    expect(scope.restoredCheckpoints.length).toBe(restoresBeforeC);
    const caseCAgent = (resumedStacks[2] as readonly AgentContinuationFrame[])[0];
    expect(caseCAgent?.neutralSyncContinuation).toBe(true);
    expect(ledger.frames.get('msg:f-c#1:case-c')?.canonical.visibleText).toContain('[TOPOLOGY_SYNC_REVERIFY] Reverify C');
    expect(await ledger.getSuspendedForks('run-bar', { parentStepExecId: 'step-bar' })).toEqual([]);

    await ledger.recordForkSuspension({
      suspendedForkId: 'f-open#2', forkId: 'f-open', suspensionEpoch: 2, runId: 'run-bar', parentStepExecId: 'step-bar',
      forkToolName: 'runChild', activePartitions: ['core'], suspensionReason: 'INTERRUPT_RAISED', conflictRetryCount: 0,
      conflictCheckArmed: false, continuationStack: [],
    });
    const abortParentDriver = new ScriptedModelDriver([
      { wireFrame: new Uint8Array(), canonical: { role: 'assistant', visibleText: '{"finished":true}' }, structuredOutput: { finished: true }, usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.01 } },
      { wireFrame: new Uint8Array(), canonical: { role: 'assistant', visibleText: '', toolCalls: [{ id: 'rf-ab', name: 'resumeFork', argsJson: JSON.stringify({ suspendedForkIds: ['f-open#2'], action: 'abort', resolutionSummary: 'drop' }) }] }, usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.01 } },
      { wireFrame: new Uint8Array(), canonical: { role: 'assistant', visibleText: '{"finished":true}' }, structuredOutput: { finished: true }, usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.01 } },
    ]);
    const reg = createExecutorRegistry({ models: { 'claude:model': () => abortParentDriver }, scopes: { 'git:cow-worktree': () => scope as never } });
    const out = await executeAgent(parent, { task: 'finish' }, {
      runId: 'run-bar', stepExecId: 'step-bar', scopeHandle: 'root:run-bar', activePartitions: ['core'], activeLeases: [], observedEffects: [],
      registry: reg, resolveEnv: () => '', getRunner: () => { throw new Error('unused'); }, recordEffects: () => undefined, _runtime: { ledgerStore: ledger },
    } as never);
    expect(out).toEqual({ finished: true });
    expect(abortParentDriver.recordedRequests.length).toBe(3);
    expect(ledger.resolvedSuspendedForks.get('f-open#2')).toBe('ABORTED');
  });
});

describe('.speculate() tournament: Post-Race Cases 1-4, candidate index gate, unpark-escalation, and refineWinnerWhen', () => {
  it('enforces Post-Race Cases 1-4, validates arbiter candidate indices, persists humanRequestId on unpark-escalation, and retains losing worktrees during refineWinnerWhen', async () => {
    const compBranch: SpeculateBranchEntryRecord = Object.freeze({ branchIndex: 0, forkId: 'b0', status: 'COMPLETED', continuationStack: Object.freeze([]) });
    const parkBranch: SpeculateBranchEntryRecord = Object.freeze({ branchIndex: 1, forkId: 'b1', status: 'PARKED_ON_ESCALATION', continuationStack: Object.freeze([]) });
    const failBranch: SpeculateBranchEntryRecord = Object.freeze({ branchIndex: 2, forkId: 'b2', status: 'FAILED', continuationStack: Object.freeze([]) });
    expect(resolvePostRaceCases([failBranch], []).caseKind).toBe('all-failed');
    expect(resolvePostRaceCases([parkBranch, failBranch], [])).toEqual({ caseKind: 'unpark-sole-escalated', targetBranchIndex: 1 });
    expect(resolvePostRaceCases([compBranch, failBranch], [])).toEqual({ caseKind: 'sole-survivor', targetBranchIndex: 0 });
    expect(resolvePostRaceCases([compBranch, parkBranch], []).caseKind).toBe('contested-arbitration');
    expect(resolvePostRaceCases([parkBranch, { ...parkBranch, branchIndex: 2 }], []).caseKind).toBe('contested-arbitration');
    expect(resolvePostRaceCases([compBranch, failBranch], [{ branchIndex: 0, interruptId: 'i1', rulingSummary: 'ok' }]).caseKind).toBe('contested-arbitration');

    const escIntr = H.interrupt('arch-q', z.object({ q: z.string() }));
    const human = H.human('arch-lead').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE);
    const worker = H.agent<string>('spec-worker').model(SAMPLE_MODEL_NODE).input(z.object({ variant: z.number() })).output(z.object({ code: z.string() }))
      .capabilities(($c) => $c.escalate(escIntr, ($e) => $e.to(human).response(z.object({ approve: z.boolean() }))));
    const arbiter = H.agent<string>('spec-arbiter').model(SAMPLE_MODEL_NODE).input(z.unknown()).output(z.object({ action: z.enum(['select-winner', 'unpark-escalation', 'reject-all']), idx: z.number(), needsRefine: z.boolean() }));
    const refiner = H.agent<string>('spec-refiner').model(SAMPLE_MODEL_NODE).input(z.object({ variant: z.number() })).output(z.object({ code: z.string() }));
    const parent = H.agent<string>('spec-parent').model(SAMPLE_MODEL_NODE).input(z.object({ prompt: z.string() })).output(z.object({ ok: z.boolean() }))
      .capabilities(($c) =>
        $c.speculate('raceBranches', ($s) =>
          $s.requestSchema(z.object({})).worker(worker).branches(2, () => [{ variant: 0 }, { variant: 1 }])
            .crossVerifyWith(SAMPLE_CROSS_VERIFIER_NODE as never)
            .arbiter(arbiter, {
              resolveDecision: (v) => v.action === 'unpark-escalation' ? { decision: 'unpark-escalation', parkedBranchIndex: v.idx, rationale: 'unpark' } : v.action === 'select-winner' ? { decision: 'select-winner', winnerBranchIndex: v.idx, rationale: 'best' } : { decision: 'reject-all', rationale: 'none' },
            })
            .refineWinnerWhen((v) => v.needsRefine, refiner, () => ({ variant: 1 })),
        ),
      ).toAST();

    const specCap = parent.capabilities?.speculations[0];
    if (specCap === undefined) throw new Error('Missing specCap');

    const ledger = new InMemoryLedgerStore();
    await ledger.createOrResumeRun({ runId: 'run-spec', laneId: 'l1', itemKey: 'k1', inputJson: '{}' });
    await ledger.recordStepStart({ runId: 'run-spec', stepExecId: 'step-spec', stepId: 's', executableId: 'spec-parent', inputMsgId: null, continuationStack: [] });

    let reqIdPersistedBeforeHumanAsk = false;
    const humanAdapter = new ScriptedHumanAdapter([
      () => {
        const stack = ledger.steps.get('step-spec')?.continuationStack ?? [];
        const sf = stack.find((f) => f.kind === 'speculate-frame');
        if (sf?.kind === 'speculate-frame') {
          const b1 = sf.branches.find((b) => b.branchIndex === 1);
          const af = b1?.continuationStack.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame');
          if (af?.pauseState.kind === 'adjudication' && af.pauseState.pendingAdjudication.humanRequestId !== undefined) {
            reqIdPersistedBeforeHumanAsk = true;
          }
        }
        return { approve: true };
      },
    ]);

    const scope = new ScriptedBranchableScope();
    await scope.acquireRoot('run-spec');
    let arbiterCall = 0;
    let b1Call = 0;
    let losingBranchAliveDuringRefine = false;

    const specRes = await executeSpeculateTournament({
      parentNode: parent as never, parentInput: { prompt: 'optimize' }, callId: 'call-spec', capability: specCap as never,
      argsJson: '{}', outerFrames: [], branchableScope: scope, lockManager: new ScopeLockManager(),
      continuationQueue: new StepContinuationQueue(), ledgerStore: ledger, humanAdaptersById: new Map([[human.id, humanAdapter]]),
      ctx: makeBaseCtx('run-spec', 'step-spec', 'root:run-spec'),
      executeChildStep: async (childNode, childInput, childCtx) => {
        if (childNode.id === 'spec-worker') {
          const v = (childInput as { variant: number }).variant;
          if (v === 0) return { status: 'completed', output: { code: 'v0-initial' }, continuationStack: [] };
          b1Call += 1;
          if (b1Call === 1) {
            const af: AgentContinuationFrame = Object.freeze({
              kind: 'agent-frame', agentId: 'spec-worker', roleKey: 'spec-worker', modelId: 'm1', stepExecId: 's-b1', inputJson: '{"variant":1}',
              leafMessageId: null, turnsTaken: 1, costUsd: 0, elapsedDurationMs: 1, activeLeases: Object.freeze([]), activeSkillIds: Object.freeze([]),
              activeSkillActivations: Object.freeze({}), observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]),
              pausedAtPhase: 'TOOL_BOUNDARY', pauseState: Object.freeze({ kind: 'active-turn' }),
            });
            return { status: 'interrupt-raised', interruptId: 'arch-q', interruptPayload: { q: 'use cache?' }, continuationStack: [af] };
          }
          return { status: 'completed', output: { code: 'v1-unparked' }, continuationStack: [] };
        }
        if (childNode.id === 'spec-arbiter') {
          arbiterCall += 1;
          if (arbiterCall === 1) return { status: 'completed', output: { action: 'select-winner', idx: 99, needsRefine: false }, continuationStack: [] };
          if (arbiterCall === 2) return { status: 'completed', output: { action: 'unpark-escalation', idx: 1, needsRefine: false }, continuationStack: [] };
          return { status: 'completed', output: { action: 'select-winner', idx: 1, needsRefine: true }, continuationStack: [] };
        }
        const candHandles = (childCtx as StepExecutionContext<string> & { readonly candidateHandles?: ReadonlyMap<number, string> }).candidateHandles;
        const b0Handle = candHandles?.get(0);
        losingBranchAliveDuringRefine = b0Handle !== undefined && scope.liveHandles.has(b0Handle) && scope.handleState.get('root:run-spec')?.['lastCommittedChild'] === undefined;
        return { status: 'completed', output: { code: 'v1-refined-with-v0' }, continuationStack: [] };
      },
    });

    expect(arbiterCall).toBe(3);
    expect(reqIdPersistedBeforeHumanAsk).toBe(true);
    expect(losingBranchAliveDuringRefine).toBe(true);
    expect(specRes.isError).toBe(false);
    expect(JSON.parse(specRes.toolResultText)).toMatchObject({
      status: 'WINNER_COMMITTED', winnerBranchIndex: 1, output: { code: 'v1-refined-with-v0' },
    });
  });
});
