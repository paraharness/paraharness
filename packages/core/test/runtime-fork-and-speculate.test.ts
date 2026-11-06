import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentContinuationFrame, type ForkBatchEntryRecord, H, type LoopContinuationFrame,
  ScopeLockManager, type SpeculateBranchEntryRecord, StepContinuationQueue,
  type StepExecutionContext, type WireFrameRecord, createExecutorRegistry, executeAgent,
  executeForkBatch, executeResumeForkBatch, executeSpeculateTournament, resolvePostRaceCases,
} from '../src/index.js';
import { InMemoryLedgerStore } from './fixtures/in-memory-ledger-store.js';
import { InMemoryLessonStore } from './fixtures/in-memory-lesson-store.js';
import {
  SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE, SAMPLE_CLEAN_TREE_CHECK_NODE,
  SAMPLE_CROSS_VERIFIER_NODE, SAMPLE_DECLARED_TOOL_NODE, SAMPLE_LESSON_STORE_NODE, SAMPLE_MODEL_NODE,
} from './fixtures/sample-domain-nodes.constants.js';
import { ScriptedBranchableScope } from './fixtures/scripted-branchable-scope.js';
import { ScriptedHumanAdapter } from './fixtures/scripted-human-adapter.js';
import { ScriptedModelDriver } from './fixtures/scripted-model-driver.js';
import { ScriptedToolDriver } from './fixtures/scripted-tool-driver.js';

function throwUnusedRunner(): never {
  throw new Error('unused');
}

function makeTurn(visibleText: string, toolCalls: ReadonlyArray<{ id: string; name: string; argsJson: string }> = [], structuredOutput?: unknown) {
  return Object.freeze({
    wireFrame: new Uint8Array(),
    canonical: Object.freeze({ role: 'assistant' as const, visibleText, toolCalls: Object.freeze([...toolCalls]) }),
    structuredOutput,
    usage: Object.freeze({ inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.01 }),
  });
}

describe('Downward .fork() history modes, real LoopNode child execution, CHILD_COMMITTED lesson idempotency, and commitChild conflict bounce', () => {
  it('executes real child AgentNode & LoopNode via ModelDriver turns, supports shared-prefix-only vs clone-transcript, bounces commitChild conflicts back to .act() with conflictLease, and releases child handles', async () => {
    const childActor = H.agent<string>('child-actor').model(SAMPLE_MODEL_NODE).input(z.object({ subtask: z.string() })).output(z.object({ done: z.string() }));
    const childEval = H.agent<string>('child-eval').model(SAMPLE_MODEL_NODE).input(z.object({ done: z.string() })).output(z.object({ ok: z.boolean() }));
    const childLoop = H.loop<string>('child-loop')
      .input(z.object({ subtask: z.string() })).output(z.object({ done: z.string() })).maxIterations(2).preserveActorSession(true)
      .act('act-step', childActor)
      .evaluate('eval-step', childEval, {
        mapInput: (_in, actOut: { readonly done: string }) => actOut,
        acceptWhen: (v: { readonly ok: boolean }) => v.ok,
        feedbackMapper: () => 'retry',
      })
      .returnOutputFrom('act-step');

    const parent = H.agent<string>('parent-agent')
      .model(SAMPLE_MODEL_NODE).input(z.object({ goal: z.string() })).output(z.object({ ok: z.boolean() }))
      .capabilities(($c) =>
        $c.fork('forkShared', childActor, ($f) =>
          $f.requestSchema(z.object({ subtask: z.string() })).mapInput((_p, req) => req).historyMode('shared-prefix-only'),
        ).fork('forkClone', childLoop, ($f) =>
          $f.requestSchema(z.object({ subtask: z.string() })).mapInput((_p, req) => req).historyMode('clone-transcript'),
        ),
      ).toAST();

    const forkSharedCap = parent.capabilities?.forks.find((f) => f.toolName === 'forkShared');
    const forkCloneCap = parent.capabilities?.forks.find((f) => f.toolName === 'forkClone');
    if (forkSharedCap === undefined || forkCloneCap === undefined) {
      throw new Error('Missing fork capabilities');
    }

    const ledger = new InMemoryLedgerStore();
    await ledger.createOrResumeRun({ runId: 'run-f1', laneId: 'l1', itemKey: 'k1', inputJson: '{}' });
    const parentMsg: WireFrameRecord = Object.freeze({
      messageId: 'msg:parent:1', parentMessageId: null, vendorId: 'anthropic',
      rawWireFrame: new Uint8Array(), canonical: Object.freeze({ role: 'user', visibleText: 'parent context' }), prefixDigest: 'p1',
    });
    await ledger.appendMessageFrame('run-f1', parentMsg);
    await ledger.recordStepStart({ runId: 'run-f1', stepExecId: 'step-p1', stepId: 'p', executableId: 'parent-agent', inputMsgId: null, continuationStack: [] });

    const scope = new ScriptedBranchableScope();
    await scope.acquireRoot('run-f1');
    scope.commitConflictRemainingCount = 1;

    const modelDriver = new ScriptedModelDriver([
      makeTurn(JSON.stringify({ done: 'clone-attempt-1' }), [], { done: 'clone-attempt-1' }),
      makeTurn(JSON.stringify({ done: 'shared-ok' }), [], { done: 'shared-ok' }),
      makeTurn(JSON.stringify({ ok: true }), [], { ok: true }),
      makeTurn(JSON.stringify({ done: 'clone-attempt-2' }), [], { done: 'clone-attempt-2' }),
      makeTurn(JSON.stringify({ ok: true }), [], { ok: true }),
    ]);
    const registry = createExecutorRegistry({
      models: { 'claude:model': () => modelDriver },
      scopes: { 'git:cow-worktree': () => scope as never },
      checks: { 'git:clean-working-tree': async () => ({ ok: true, deficits: [] }) },
    });

    const batchRes = await executeForkBatch({
      parentNode: parent as never, parentInput: { goal: 'build' }, parentLeafMessageId: 'msg:parent:1', outerFrames: [],
      forkCalls: [
        { callId: 'c-clone', forkId: 'f-clone', capability: forkCloneCap as never, argsJson: JSON.stringify({ subtask: 's2' }) },
        { callId: 'c-shared', forkId: 'f-shared', capability: forkSharedCap as never, argsJson: JSON.stringify({ subtask: 's1' }) },
      ],
      branchableScope: scope, lockManager: new ScopeLockManager(), continuationQueue: new StepContinuationQueue(),
      ledgerStore: ledger, modelDriver,
      ctx: Object.freeze({
        runId: 'run-f1', stepExecId: 'step-p1', scopeHandle: 'root:run-f1', activePartitions: ['core'],
        activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined,
      }),
    });

    expect(modelDriver.recordedForks.map((f) => f.ctx.historyMode)).toEqual(['clone-transcript', 'shared-prefix-only']);
    expect(ledger.frames.get('msg:f-clone:conflict:1')?.canonical.visibleText).toContain('[COMMIT_CONFLICT] Conflict merging');
    expect(JSON.parse(batchRes.toolResultsByCallId.get('c-clone')?.content ?? '{}').output).toEqual({ done: 'clone-attempt-2' });
    expect(JSON.parse(batchRes.toolResultsByCallId.get('c-shared')?.content ?? '{}').output).toEqual({ done: 'shared-ok' });
    expect([...scope.liveHandles]).toEqual(['root:run-f1']);
  });
});

describe('Upward .onChildInterrupt() turn-batch barrier, resumeFork Cases A/B/C with exact wire headers, write-locked syncChild, and Case C neutralSyncContinuation reset', () => {
  it('coordinates turn-batch barrier, acquires write lock around restoreCheckpoint + syncChild, injects exact SPEC §3.7.2 wire headers, resets neutralSyncContinuation without false gate distillation, and releases handles on abort', async () => {
    const childIntr = H.interrupt('schema-gap', z.object({ reason: z.string() }));
    const lessonsBuilder = H.lessons<string>('lessons-c').store(SAMPLE_LESSON_STORE_NODE).distillWith(SAMPLE_MODEL_NODE, ($d) => $d.onGateRecovery({ minFailedChecks: 1 }));
    const childActor = H.agent<string>('act-worker-role').model(SAMPLE_MODEL_NODE).input(z.object({ id: z.string() })).output(z.object({ ok: z.boolean() }));
    const childEval = H.agent<string>('eval-only').model(SAMPLE_MODEL_NODE).canRaise(childIntr).input(z.object({ ok: z.boolean() })).output(z.object({ accepted: z.boolean() }));
    const childLoop = H.loop<string>('l-raise')
      .input(z.object({ id: z.string() })).output(z.object({ ok: z.boolean() })).maxIterations(2).preserveActorSession(true)
      .act('act-s', childActor)
      .evaluate('eval-s', childEval, {
        mapInput: (_in, actOut: { readonly ok: boolean }) => actOut,
        acceptWhen: (v: { readonly accepted: boolean }) => v.accepted,
        feedbackMapper: () => 'retry',
      })
      .returnOutputFrom('act-s');

    const childWorkerC = H.agent<string>('child-worker-c')
      .model(SAMPLE_MODEL_NODE).lessons(lessonsBuilder).beforeStop(SAMPLE_CLEAN_TREE_CHECK_NODE)
      .input(z.object({ id: z.string() })).output(z.object({ ok: z.boolean() }));

    const parent = H.agent<string>('parent-barrier')
      .model(SAMPLE_MODEL_NODE).input(z.object({ task: z.string() })).output(z.object({ finished: z.boolean() }))
      .capabilities(($c) =>
        $c.fork('runChild', childLoop, ($f) => $f.requestSchema(z.object({ id: z.string() })).mapInput((_p, r) => r))
          .fork('runChildC', childWorkerC, ($f) => $f.requestSchema(z.object({ id: z.string() })).mapInput((_p, r) => r)),
      )
      .onChildInterrupt(childIntr, ($ci) => $ci.pauseSiblingForksInPartitions(() => ['core']).suspendAndReturnToParent())
      .toAST();

    const forkCap = parent.capabilities?.forks[0];
    const forkCapC = parent.capabilities?.forks[1];
    if (forkCap === undefined || forkCapC === undefined) {
      throw new Error('Expected fork capabilities');
    }

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
    const lockManager = new ScopeLockManager();
    const lessonStore = new InMemoryLessonStore();

    const sibBFrame: AgentContinuationFrame = Object.freeze({
      kind: 'agent-frame', agentId: 'act-worker-role', roleKey: 'act-worker-role', modelId: SAMPLE_MODEL_NODE.modelId, stepExecId: 's-b', inputJson: '{"id":"f-b"}',
      leafMessageId: 'msg:sib-b:tool', turnsTaken: 1, costUsd: 0, elapsedDurationMs: 1, activeLeases: Object.freeze([]), activeSkillIds: Object.freeze([]),
      activeSkillActivations: Object.freeze({}), observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]), pausedAtPhase: 'TOOL_BOUNDARY',
      pauseState: Object.freeze({ kind: 'adjudication', pendingAdjudication: Object.freeze({ interruptId: 'h-int', interruptPayloadJson: '{}', humanRequestId: 'req-sib-b-1' }) }),
    });
    const sibCFrame: AgentContinuationFrame = Object.freeze({
      kind: 'agent-frame', agentId: 'child-worker-c', roleKey: 'child-worker-c', modelId: SAMPLE_MODEL_NODE.modelId, stepExecId: 's-c', inputJson: '{"id":"f-c"}',
      leafMessageId: 'msg:sib-c:leaf', turnsTaken: 1, costUsd: 0, elapsedDurationMs: 1, activeLeases: Object.freeze([]), activeSkillIds: Object.freeze([]),
      activeSkillActivations: Object.freeze({}), observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]), pausedAtPhase: 'BEFORE_STOP_GATE', pauseState: Object.freeze({ kind: 'before-stop-gate' }),
    });

    const modelDriver = new ScriptedModelDriver([
      makeTurn(JSON.stringify({ ok: true }), [], { ok: true }),
      makeTurn('raise gap', [{ id: 'intr-call-1', name: 'schema-gap', argsJson: JSON.stringify({ reason: 'missing col' }) }]),
      makeTurn(JSON.stringify({ ok: true }), [], { ok: true }),
      makeTurn(JSON.stringify({ accepted: true }), [], { accepted: true }),
      makeTurn(JSON.stringify({ ok: true }), [], { ok: true }),
      makeTurn(JSON.stringify({ accepted: true }), [], { accepted: true }),
      makeTurn(JSON.stringify({ ok: true }), [], { ok: true }),
    ]);
    const registry = createExecutorRegistry({
      models: { 'claude:model': () => modelDriver },
      scopes: { 'git:cow-worktree': () => scope as never },
      checks: { 'git:clean-working-tree': async () => ({ ok: true, deficits: [] }) },
    });
    const baseCtx: StepExecutionContext<string> = Object.freeze({
      runId: 'run-bar', stepExecId: 'step-bar', scopeHandle: 'root:run-bar', activePartitions: ['core'],
      activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined,
    });

    await executeForkBatch({
      parentNode: parent as never, parentInput: { task: 'go' }, parentLeafMessageId: null, outerFrames: [],
      forkCalls: [
        { callId: 'c-a', forkId: 'f-a', capability: forkCap as never, argsJson: JSON.stringify({ id: 'f-a' }) },
        { callId: 'c-b', forkId: 'f-b', capability: forkCap as never, argsJson: JSON.stringify({ id: 'f-b' }) },
        { callId: 'c-c', forkId: 'f-c', capability: forkCapC as never, argsJson: JSON.stringify({ id: 'f-c' }) },
      ],
      branchableScope: scope, lockManager, continuationQueue: new StepContinuationQueue(),
      ledgerStore: ledger, lessonStore, modelDriver, humanAdaptersById: new Map([['h1', humanAdapter]]), ctx: baseCtx,
      executeChildStep: async (childNode, rawIn, childCtx) => {
        const id = (rawIn as { id: string }).id;
        if (id === 'f-b' && childCtx.resumeContinuationStack === undefined) {
          return { status: 'completed', output: { ok: false }, continuationStack: [sibBFrame] };
        }
        if (id === 'f-c' && childCtx.resumeContinuationStack === undefined) {
          return { status: 'completed', output: { ok: false }, continuationStack: [sibCFrame] };
        }
        const out = await executeAgent(
          childNode.type === 'harness:loop' ? childActor.toAST() : childWorkerC.toAST(),
          rawIn as { readonly id: string },
          { ...childCtx, _runtime: { ledgerStore: ledger, lessonStore, lockManager } } as StepExecutionContext<string> & { readonly _runtime: unknown },
        );
        if (id === 'f-a' && childCtx.resumeContinuationStack === undefined) {
          const raisingLoop: LoopContinuationFrame = Object.freeze({
            kind: 'loop-frame', loopId: 'l-raise', roleKey: 'act-worker-role', lastActModelId: SAMPLE_MODEL_NODE.modelId, stepExecId: 's-r', loopInputJson: '{"id":"f-a"}',
            iteration: 0, phase: 'evaluate', preservedActLeafMessageId: 'msg:act-preserved', turnsTaken: 1, costUsd: 0, elapsedDurationMs: 1,
            actTurnsTaken: 1, actCostUsd: 0, actElapsedDurationMs: 1, grantedLoopLeases: Object.freeze([]), activeSkillIds: Object.freeze([]),
            activeSkillActivations: Object.freeze({}), observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]), recalledLessons: Object.freeze([]), accumulatedLessonOutcomes: Object.freeze({}),
          });
          return { status: 'interrupt-raised', interruptId: 'schema-gap', interruptPayload: { reason: 'missing col' }, raisedByPhase: 'evaluate', continuationStack: [raisingLoop] };
        }
        return { status: 'completed', output: out, continuationStack: [] };
      },
    });

    expect(humanAdapter.cancelledRequests.map((r) => r.requestId)).toEqual(['req-sib-b-1']);
    const openForks = await ledger.getSuspendedForks('run-bar', { parentStepExecId: 'step-bar' });
    expect(openForks.map((f) => f.suspendedForkId).sort()).toEqual(['f-a#1', 'f-b#1', 'f-c#1']);

    let writeLockedDuringSyncChild = false;
    const origSyncChild = scope.syncChild.bind(scope);
    scope.syncChild = async (parentH, childH) => {
      writeLockedDuringSyncChild = lockManager.isWriteLocked(parentH);
      return origSyncChild(parentH, childH);
    };

    const resumeRes = await executeResumeForkBatch({
      parentNode: parent as never, parentInput: { task: 'go' }, parentLeafMessageId: null, outerFrames: [],
      resumeRequest: { callId: 'rf-1', suspendedForkIds: ['f-a#1', 'f-b#1'], action: 'resume', resolutionSummary: 'Fixed schema' },
      branchableScope: scope, lockManager, continuationQueue: new StepContinuationQueue(),
      ledgerStore: ledger, lessonStore, modelDriver, ctx: baseCtx,
    });

    expect(writeLockedDuringSyncChild).toBe(true);
    const parsedMulti = JSON.parse(resumeRes.toolResultsByCallId.get('rf-1')?.content ?? '{}') as { results: Array<{ forkId: string }> };
    expect(parsedMulti.results.map((r) => r.forkId)).toEqual(['f-a', 'f-b']);
    expect(ledger.frames.get('msg:f-a#1:case-a')?.canonical.visibleText).toContain('[CONTRACT_VIOLATION_RESOLVED]: Original Deficit:');
    expect(ledger.frames.get('msg:sib-b:tool')?.canonical.visibleText).toContain('[TOPOLOGY_SYNC]: Fixed schema');

    const preSyncedEntry: ForkBatchEntryRecord = Object.freeze({
      forkId: 'f-c', suspendedForkId: 'f-c#1', callId: 'rf-c', toolName: 'runChildC', activePartitions: Object.freeze(['core']),
      status: 'RUNNING', conflictRetryCount: 0, conflictCheckArmed: false, suspensionEpoch: 1,
      syncedToParentCheckpoint: 'ckpt:already-synced', syncResultJson: '{"status":"clean"}',
      continuationStack: Object.freeze([sibCFrame]),
    });
    const restoresBeforeC = scope.restoredCheckpoints.length;
    const singleResumeRes = await executeResumeForkBatch({
      parentNode: parent as never, parentInput: { task: 'go' }, parentLeafMessageId: null, outerFrames: [],
      existingBatchFrame: { kind: 'fork-batch-frame', parentStepExecId: 'step-bar', forks: [preSyncedEntry] },
      resumeRequest: { callId: 'rf-c', suspendedForkIds: ['f-c#1'], action: 'resume', resolutionSummary: 'Reverify C' },
      branchableScope: scope, lockManager, continuationQueue: new StepContinuationQueue(),
      ledgerStore: ledger, lessonStore, modelDriver, ctx: baseCtx,
    });
    expect(scope.restoredCheckpoints.length).toBe(restoresBeforeC);
    const parsedSingle = JSON.parse(singleResumeRes.toolResultsByCallId.get('rf-c')?.content ?? '{}') as { forkId?: string; status?: string };
    expect(parsedSingle.forkId).toBe('f-c');
    expect(parsedSingle.status).toBe('COMPLETED');
    expect(ledger.frames.get('msg:f-c#1:case-c')?.canonical.visibleText).toContain('[TOPOLOGY_SYNC_REVERIFY]: Upstream contract updated (Reverify C).');
    expect(lessonStore.lessons.size).toBe(0);

    await ledger.recordForkSuspension({
      suspendedForkId: 'f-open#2', forkId: 'f-open', suspensionEpoch: 2, runId: 'run-bar', parentStepExecId: 'step-bar',
      forkToolName: 'runChild', activePartitions: ['core'], suspensionReason: 'INTERRUPT_RAISED', conflictRetryCount: 0,
      conflictCheckArmed: false, continuationStack: [],
    });
    const abortParentDriver = new ScriptedModelDriver([
      makeTurn('{"finished":true}', [], { finished: true }),
      makeTurn('', [{ id: 'rf-ab', name: 'resumeFork', argsJson: JSON.stringify({ suspendedForkIds: ['f-open#2'], action: 'abort', resolutionSummary: 'drop' }) }]),
      makeTurn('{"finished":true}', [], { finished: true }),
    ]);
    const reg = createExecutorRegistry({ models: { 'claude:model': () => abortParentDriver }, scopes: { 'git:cow-worktree': () => scope as never } });
    const out = await executeAgent(parent, { task: 'finish' }, {
      ...baseCtx, registry: reg, _runtime: { ledgerStore: ledger, branchableScope: scope },
    } as StepExecutionContext<string> & { readonly _runtime: unknown });
    expect(out).toEqual({ finished: true });
    expect(ledger.resolvedSuspendedForks.get('f-open#2')).toBe('ABORTED');
    expect([...scope.liveHandles]).toEqual(['root:run-bar']);
  });
});

describe('.speculate() tournament: Post-Race Cases 1-4, real child/arbiter execution, refineWinnerWhen rollback & lessons, and handle release', () => {
  it('enforces Post-Race Cases 1-4 (including Case 3 verifyWinnerWith fallback to Case 1), executes real child/arbiter/refiner via ModelDriver, rolls back failed refinement, and releases all branch handles', async () => {
    const compBranch: SpeculateBranchEntryRecord = Object.freeze({ branchIndex: 0, forkId: 'b0', status: 'COMPLETED', continuationStack: Object.freeze([]) });
    const parkBranch: SpeculateBranchEntryRecord = Object.freeze({ branchIndex: 1, forkId: 'b1', status: 'PARKED_ON_ESCALATION', continuationStack: Object.freeze([]) });
    const failBranch: SpeculateBranchEntryRecord = Object.freeze({ branchIndex: 2, forkId: 'b2', status: 'FAILED', continuationStack: Object.freeze([]) });
    expect(resolvePostRaceCases([failBranch], []).caseKind).toBe('all-failed');
    expect(resolvePostRaceCases([parkBranch, failBranch], [])).toEqual({ caseKind: 'unpark-sole-escalated', targetBranchIndex: 1 });
    expect(resolvePostRaceCases([compBranch, failBranch], [])).toEqual({ caseKind: 'sole-survivor', targetBranchIndex: 0 });
    expect(resolvePostRaceCases([compBranch, parkBranch], []).caseKind).toBe('contested-arbitration');

    const escIntr = H.interrupt('arch-q', z.object({ q: z.string() }));
    const human = H.human('arch-lead').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE);
    const worker = H.agent<string>('spec-worker').model(SAMPLE_MODEL_NODE).tools(SAMPLE_DECLARED_TOOL_NODE as never).input(z.object({ variant: z.number() })).output(z.object({ code: z.string() }))
      .capabilities(($c) => $c.escalate(escIntr, ($e) => $e.to(human).response(z.object({ approve: z.boolean() }))));
    const arbiter = H.agent<string>('spec-arbiter').model(SAMPLE_MODEL_NODE).input(z.unknown()).output(z.object({ action: z.enum(['select-winner', 'unpark-escalation', 'reject-all']), idx: z.number(), needsRefine: z.boolean() }));
    const refiner = H.agent<string>('spec-refiner').model(SAMPLE_MODEL_NODE).tools(SAMPLE_DECLARED_TOOL_NODE as never).input(z.object({ variant: z.number() })).output(z.object({ code: z.string() }));
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
    if (specCap === undefined) {
      throw new Error('Missing specCap');
    }

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
    let losingBranchAliveDuringRefine = false;
    const modelDriver = new ScriptedModelDriver([
      makeTurn(JSON.stringify({ code: 'v0-initial' }), [], { code: 'v0-initial' }),
      makeTurn('escalate', [{ id: 'esc-1', name: 'arch-q', argsJson: JSON.stringify({ q: 'use cache?' }) }]),
      makeTurn(JSON.stringify({ action: 'select-winner', idx: 99, needsRefine: false }), [], { action: 'select-winner', idx: 99, needsRefine: false }),
      makeTurn(JSON.stringify({ action: 'unpark-escalation', idx: 1, needsRefine: false }), [], { action: 'unpark-escalation', idx: 1, needsRefine: false }),
      makeTurn(JSON.stringify({ code: 'v1-unparked' }), [], { code: 'v1-unparked' }),
      makeTurn(JSON.stringify({ action: 'select-winner', idx: 1, needsRefine: true }), [], { action: 'select-winner', idx: 1, needsRefine: true }),
      makeTurn('inspect peer', [{ id: 'ref-t1', name: 'fs_read', argsJson: JSON.stringify({ path: 'peer.ts' }) }]),
      makeTurn(JSON.stringify({ code: 'v1-refined-with-v0' }), [], { code: 'v1-refined-with-v0' }),
    ]);
    const toolDriver = new ScriptedToolDriver<string>({
      handler: (_n, _a, tCtx) => {
        const b0Handle = tCtx.candidateHandles?.get(0);
        losingBranchAliveDuringRefine = b0Handle !== undefined && scope.liveHandles.has(b0Handle) && scope.handleState.get('root:run-spec')?.['lastCommittedChild'] === undefined;
        return { content: 'peer-code', isError: false };
      },
    });
    const registry = createExecutorRegistry({
      models: { 'claude:model': () => modelDriver },
      tools: { 'fs:read': toolDriver },
      scopes: { 'git:cow-worktree': () => scope as never },
    });

    const specRes = await executeSpeculateTournament({
      parentNode: parent as never, parentInput: { prompt: 'optimize' }, callId: 'call-spec', capability: specCap as never,
      argsJson: '{}', outerFrames: [], branchableScope: scope, lockManager: new ScopeLockManager(),
      continuationQueue: new StepContinuationQueue(), ledgerStore: ledger, humanAdaptersById: new Map([[human.id, humanAdapter]]),
      ctx: Object.freeze({
        runId: 'run-spec', stepExecId: 'step-spec', scopeHandle: 'root:run-spec', activePartitions: ['core'],
        activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined,
      }),
    });

    expect(reqIdPersistedBeforeHumanAsk).toBe(true);
    expect(losingBranchAliveDuringRefine).toBe(true);
    expect(specRes.isError).toBe(false);
    expect(JSON.parse(specRes.toolResultText)).toMatchObject({
      status: 'WINNER_COMMITTED', winnerBranchIndex: 1, output: { code: 'v1-refined-with-v0' },
    });
    expect([...scope.liveHandles]).toEqual(['root:run-spec']);
  });
});
