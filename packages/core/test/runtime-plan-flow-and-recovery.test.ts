import { describe, expect, it } from 'vitest';
import {
  type AgentContinuationFrame, BudgetApprovalSchema, type ForkBatchContinuationFrame, type GitKeepWorktreeNode,
  type GitWorktreeHandle, H, type InlineSkillNode, LaneScheduler, type LocalServiceNode, ScopeLockManager,
  ServiceSessionRegistry, type SpeculateContinuationFrame, type SqliteLedgerNode, StepContinuationQueue,
  type StepExecutionContext, createExecutorRegistry, createRuntime, executeAddDependencies,
  executeHierarchicalRewindDrain, executeSpawnTasks, executeUpdatePartitionContract, recoverInterruptedRunOnBoot,
  syncSuspendedRunPrerequisites, z,
} from '../src/index.js';
import { InMemoryLedgerStore } from './fixtures/in-memory-ledger-store.js';
import { InMemoryLessonStore } from './fixtures/in-memory-lesson-store.js';
import { InMemoryTopologyStore } from './fixtures/in-memory-topology-store.js';
import {
  SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE, SAMPLE_MODEL_NODE, SAMPLE_RUNNER_NODE, SAMPLE_TIER3_SCOPE_NODE, SAMPLE_TOPOLOGY_STORE_NODE,
} from './fixtures/sample-domain-nodes.constants.js';
import { ScriptedBranchableScope } from './fixtures/scripted-branchable-scope.js';
import { ScriptedHumanAdapter } from './fixtures/scripted-human-adapter.js';
import { ScriptedServiceSession } from './fixtures/scripted-service-session.js';

const SAMPLE_SERVICE_NODE: LocalServiceNode = Object.freeze({
  type: 'node:service', id: 'db-daemon', lifecycle: 'skill', toolSchemas: Object.freeze([]),
  runner: SAMPLE_RUNNER_NODE, ports: Object.freeze([]), startArgv: () => Object.freeze(['node', 'db.js']), interactions: Object.freeze([]),
});

function createBaseAgentFrame(stepExecId: string): AgentContinuationFrame {
  return Object.freeze<AgentContinuationFrame>({
    kind: 'agent-frame', stepExecId, agentId: 'planner-agent', roleKey: 'planner-agent', modelId: 'claude-opus-4-6',
    inputJson: '{}', turnsTaken: 1, costUsd: 0.1, elapsedDurationMs: 10, leafMessageId: 'msg-1',
    activeSkillIds: Object.freeze(['skill-db']), activeSkillActivations: Object.freeze({}),
    injectedScopedRuleIds: Object.freeze([]), activeLeases: Object.freeze([]), observedEffects: Object.freeze([]),
    pausedAtPhase: 'TOOL_BOUNDARY',
    pauseState: Object.freeze({
      kind: 'active-turn',
      pendingToolBatch: Object.freeze({
        completedResults: Object.freeze([]), blockedCalls: Object.freeze([]),
        remainingCalls: Object.freeze([{ callId: 'call-after', toolName: 'finish', argsJson: '{}' }]),
      }),
    }),
  });
}

describe('M2 Runtime — Dynamic Plan Mutation (.mutatePlan, spawnTasks, syncRoot, Replay Idempotency)', () => {
  it('chains spawned tasks linearly (T_prevTip <- T_1 <- T_2 <- T_parent), boosts priority, suspends with headScopeCheckpoint, and runs replay-idempotent wakeup & [PREREQUISITE_FAILED]', async () => {
    const ledgerStore = new InMemoryLedgerStore();
    const topologyStore = new InMemoryTopologyStore({ core: { contractText: 'v1', epoch: 1 } });
    const scope = new ScriptedBranchableScope();
    const serviceRegistry = new ServiceSessionRegistry();
    const daemonSession = new ScriptedServiceSession('db-daemon');
    const registry = createExecutorRegistry({ services: { 'node:service': async () => daemonSession } });
    const parentHandle = await scope.acquireRoot('run-parent');
    const dbSkill: InlineSkillNode<string> = Object.freeze({
      type: 'harness:skill', id: 'skill-db', description: 'DB skill', instructions: 'Use db',
      unlockedTools: Object.freeze([]), unlockedServices: Object.freeze([SAMPLE_SERVICE_NODE]), leaseMode: 'until-completed-or-fork-exit',
    });
    await serviceRegistry.acquireSkillServices({
      runId: 'run-parent', scopeKey: 'step-parent-1', scopeHandle: parentHandle, skill: dbSkill,
      driverContext: { registry, resolveEnv: () => '', getRunner: () => { throw new Error('unused'); } },
    });
    expect(daemonSession.running).toBe(true);

    const topologyBuilder = H.topology('topo-plan').store(SAMPLE_TOPOLOGY_STORE_NODE).partitions({ core: { dependsOn: [] } });
    const taskSchema = z.object({ id: z.string(), title: z.string(), tag: z.string().optional() });
    const mutatePlanCap = H.agent('planner-agent')
      .model(SAMPLE_MODEL_NODE).input(taskSchema).output(taskSchema)
      .capabilities(($c) =>
        $c.mutatePlan(($m) =>
          $m
            .canSpawnTasks(taskSchema, {
              maxSpawnedPerRun: 3, maxPrerequisiteDepth: 4, priorityStrategy: 'inherit-parent-with-boost',
              enforcePatch: { tag: 'enforced-patch' }, onPrerequisiteSpawned: 'suspend-and-yield-slot', resumeWhen: 'prerequisite-exit',
            })
            .canAddDependencies()
            .canUpdateTopologyContracts(topologyBuilder),
        ),
      )
      .toAST().capabilities?.mutatePlan;
    if (mutatePlanCap === undefined) throw new Error('Expected mutatePlan capability node.');

    await ledgerStore.createOrResumeRun({ runId: 'run-parent', laneId: 'lane-main', itemKey: 'T_parent', inputJson: JSON.stringify({ id: 'T_parent' }) });
    const initialFrame = createBaseAgentFrame('step-parent-1');
    await ledgerStore.recordStepStart({ runId: 'run-parent', stepExecId: 'step-parent-1', stepId: 'step-1', inputMsgId: null, continuationStack: [initialFrame] });

    const stepCtx: StepExecutionContext<string> = {
      runId: 'run-parent', stepExecId: 'step-parent-1', scopeHandle: parentHandle, activePartitions: ['core'],
      activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: () => { throw new Error('unused'); }, recordEffects: () => undefined,
    };

    const spawnRes = await executeSpawnTasks({
      mutatePlanNode: mutatePlanCap, ctx: stepCtx, laneId: 'lane-main', parentItemKey: 'T_parent', parentPriority: 'normal',
      previouslySpawnedCount: 1, previousSpawnedTipKey: 'T_prevTip',
      tasksToSpawn: [{ item: { id: 'T_1', title: 'First Subtask' } }, { item: { id: 'T_2', title: 'Second Subtask' } }],
      ledgerStore, topologyStore, checkpointScope: scope, serviceRegistry, agentFrame: initialFrame,
      pendingToolBatch: { completedResults: [], blockedCalls: [], remainingCalls: [{ callId: 'call-after', toolName: 'finish', argsJson: '{}' }] },
    });

    expect(spawnRes.suspended).toBe(true);
    expect(spawnRes.prerequisiteItemKeys).toEqual(['T_1', 'T_2']);
    expect(spawnRes.latestTipItemKey).toBe('T_2');
    expect(spawnRes.headScopeCheckpoint).toBe('ckpt:root:run-parent:1');
    expect(daemonSession.running).toBe(false);
    expect(ledgerStore.planMutations[0]?.spawnedItems).toEqual([
      { itemKey: 'T_1', inputJson: JSON.stringify({ id: 'T_1', title: 'First Subtask', tag: 'enforced-patch' }), dependsOn: ['T_prevTip'], priority: 'high' },
      { itemKey: 'T_2', inputJson: JSON.stringify({ id: 'T_2', title: 'Second Subtask', tag: 'enforced-patch' }), dependsOn: ['T_1'], priority: 'high' },
    ]);
    expect(ledgerStore.planMutations[0]?.addedDependencies).toEqual(['T_2']);

    await expect(
      executeSpawnTasks({
        mutatePlanNode: mutatePlanCap, ctx: stepCtx, laneId: 'lane-main', parentItemKey: 'T_parent', parentPriority: 'normal',
        previouslySpawnedCount: 3, tasksToSpawn: [{ item: { id: 'T_3', title: 'Overflow' } }], ledgerStore,
      }),
    ).rejects.toThrow(/exceeds maxSpawnedPerRun/);

    const contractRes = await executeUpdatePartitionContract({
      mutatePlanNode: mutatePlanCap, ctx: stepCtx, laneId: 'lane-main', parentItemKey: 'T_parent', parentPriority: 'normal',
      contractUpdate: { partitionId: 'core', newContractText: 'v2-from-parent' }, ledgerStore, topologyStore,
    });
    expect(contractRes).toEqual({ partitionId: 'core', newEpoch: 2 });

    await topologyStore.updateContract('run-T1', 'core', 'v2-from-T1', 'step-t1');
    await ledgerStore.recordRunTerminalReceipt('run-T1', 'T_1', 'completed', JSON.stringify({ branch: 't1', sha: '111' }));
    await ledgerStore.recordRunTerminalReceipt('run-T2', 'T_2', 'completed', JSON.stringify({ branch: 't2', sha: '222' }));

    scope.handleState.set(parentHandle, { handle: parentHandle, dirtyBeforeWakeup: true });
    scope.syncRootConflictRemainingCount = 1;
    const pausedFrame = ledgerStore.steps.get('step-parent-1')?.continuationStack[0] as AgentContinuationFrame | undefined;
    const syncWakeup1 = await syncSuspendedRunPrerequisites({
      runId: 'run-parent', stepExecId: 'step-parent-1', headScopeCheckpoint: spawnRes.headScopeCheckpoint,
      prerequisiteItemKeys: ['T_1', 'T_2'], agentFrame: pausedFrame, ledgerStore,
      continuationQueue: new StepContinuationQueue(), topologyStore, branchableScope: scope, serviceRegistry, scopeHandle: parentHandle,
    });
    expect(syncWakeup1.allPrerequisitesSucceeded).toBe(true);
    expect(syncWakeup1.conflictCheckArmed).toBe(true);
    expect(syncWakeup1.conflictLease?.id).toBe('conflict-resolution-lease');
    expect(scope.restoredCheckpoints).toEqual([{ handle: parentHandle, checkpoint: 'ckpt:root:run-parent:1' }]);
    expect(syncWakeup1.updatedAgentFrame?.syncedToPrerequisiteCheckpoint).toBe('ckpt:root:run-parent:2');

    const restoredCountBeforeReplay = scope.restoredCheckpoints.length;
    const syncWakeupReplay = await syncSuspendedRunPrerequisites({
      runId: 'run-parent', stepExecId: 'step-parent-1', headScopeCheckpoint: spawnRes.headScopeCheckpoint,
      prerequisiteItemKeys: ['T_1', 'T_2'], agentFrame: syncWakeup1.updatedAgentFrame, ledgerStore,
      continuationQueue: new StepContinuationQueue(), topologyStore, branchableScope: scope, serviceRegistry, scopeHandle: parentHandle,
    });
    expect(scope.restoredCheckpoints).toHaveLength(restoredCountBeforeReplay);
    expect(syncWakeupReplay.updatedAgentFrame?.syncedToPrerequisiteCheckpoint).toBe('ckpt:root:run-parent:2');

    await ledgerStore.recordRunTerminalReceipt('run-T3', 'T_3', 'failed');
    const addDepRes = await executeAddDependencies({
      mutatePlanNode: mutatePlanCap, ctx: stepCtx, laneId: 'lane-main', parentItemKey: 'T_parent',
      parentPriority: 'normal', dependencyKeysToAdd: ['T_3'], ledgerStore,
    });
    expect(addDepRes.suspended).toBe(false);

    const failedSync = await syncSuspendedRunPrerequisites({
      runId: 'run-parent', stepExecId: 'step-parent-1', prerequisiteItemKeys: ['T_3'],
      ledgerStore, continuationQueue: new StepContinuationQueue(), scopeHandle: parentHandle,
    });
    expect(failedSync.allPrerequisitesSucceeded).toBe(false);
    expect(failedSync.syncNotes.some((n) => n.includes('[PREREQUISITE_FAILED]'))).toBe(true);
  });
});

describe('M2 Runtime — H.lane (syncRoot on QUEUED->RUNNING, .maxCostUsd, .retry, Hierarchical Rewind Drain, commitOverlayWhen & compactWhen)', () => {
  it('runs initial syncRoot on QUEUED->RUNNING, enforces .maxCostUsd (2x default approval and denial drain), resets step overlay on .retry, and defers rewind while SUSPENDED', async () => {
    const ledgerStore = new InMemoryLedgerStore();
    const topologyStore = new InMemoryTopologyStore({ api: { contractText: 'v1', epoch: 1 } });
    const lessonStore = new InMemoryLessonStore();
    const scope = new ScriptedBranchableScope();
    const humanAdapter = new ScriptedHumanAdapter();
    const budgetHuman = H.human('budget-human').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE).withName('budget-approver').output(BudgetApprovalSchema);
    const rewindSignal = H.signal('sig-amend', z.object({ id: z.string(), note: z.string() }));
    const prMergedSignal = H.signal('sig-pr-merged', z.object({ itemKey: z.string(), baseBranch: z.string(), prerequisiteRunId: z.string().optional() }));
    const compactSignal = H.signal('sig-compact', z.object({ itemKey: z.string() }));
    const rewoundHandles: string[] = [];
    const rewindHook: GitKeepWorktreeNode = Object.freeze({ type: 'git:keep-worktree', id: 'git-keep-hook', resetsRunOverlay: false });

    const itemSchema = z.object({ id: z.string(), deps: z.array(z.string()).default([]), failStep2: z.boolean().optional(), note: z.string().optional() });
    let step2Attempts = 0;
    const step1Cmd = H.command('cmd-step-1', {
      input: itemSchema, output: z.object({ step1Done: z.boolean(), note: z.string() }),
      fn: async (input: z.output<typeof itemSchema>) => {
        await topologyStore.updateContract(`run:lane-1:${input.id}`, 'api', 'v2-step1', `run:lane-1:${input.id}:step-1:1`);
        return { step1Done: true, note: input.note ?? 'initial' };
      },
    });
    const step2Cmd = H.command('cmd-step-2', {
      input: itemSchema, output: z.object({ attempts: z.number() }),
      fn: async (input: z.output<typeof itemSchema>) => {
        step2Attempts += 1;
        await topologyStore.updateContract(`run:lane-1:${input.id}`, 'api', `v3-step2-try-${String(step2Attempts)}`, `run:lane-1:${input.id}:step-2:${String(step2Attempts)}`);
        if (input.failStep2 === true && step2Attempts === 1) throw new Error('Transient step-2 failure');
        return { attempts: step2Attempts };
      },
    });

    const flow = H.flow('flow-lane-1').input(itemSchema).scope(SAMPLE_TIER3_SCOPE_NODE).step('step-1', step1Cmd).step('step-2', step2Cmd).exit('merged');
    const lane = H.lane('lane-1')
      .input(itemSchema).key((i: z.output<typeof itemSchema>) => i.id).runs(flow).concurrency(2).priority('normal').agingMinutes(10)
      .waitFor((i: z.output<typeof itemSchema>) => i.deps, 'abandoned').maxCostUsd(1.0, budgetHuman)
      .retry(($r) => $r.tries(2).exponential(0).orFail('failed'))
      .onSignal(rewindSignal, ($s) =>
        $s.update((prev: z.output<typeof itemSchema>, sig: { readonly id: string; readonly note: string }) => ({ ...prev, note: sig.note })).rewindTo('step-1', { onRewind: rewindHook }),
      );

    const registry = createExecutorRegistry({
      scopes: { 'git:cow-worktree': () => scope as never },
      rewindHooks: { 'git:keep-worktree': async (_node, target) => { rewoundHandles.push(String((target as { readonly handle: string }).handle)); } },
      ledgers: { 'sqlite:ledger': () => ledgerStore },
    });

    const scheduler = new LaneScheduler({
      lane: lane.toAST(), registry, env: {}, ledgerStore, topologyStore, lessonStore, humanAdaptersById: new Map([['budget-human', humanAdapter]]),
    });

    await scheduler.enqueueItem({ input: { id: 'item-prereq', deps: [] }, enqueuedAtMs: 1_000 });
    await scheduler.enqueueItem({ input: { id: 'item-child', deps: ['item-prereq'], failStep2: true }, enqueuedAtMs: 1_000 });
    expect(scheduler.getItemsByKey().get('item-child')?.status).toBe('WAITING');

    const pass1 = await scheduler.scheduleNextReadyRuns(1_000 + 20 * 60_000);
    expect(pass1[0]?.runId).toBe('run:lane-1:item-prereq');

    const pass2 = await scheduler.scheduleNextReadyRuns(1_000 + 20 * 60_000);
    expect(pass2[0]?.runId).toBe('run:lane-1:item-child');
    expect(step2Attempts).toBe(2);
    expect(scope.handleState.get('root:run:lane-1:item-child')?.['syncedPrerequisiteCount']).toBe(1);
    expect((await topologyStore.getPartitions('run:lane-1:item-child')).get('api')?.contractText).toBe('v3-step2-try-2');

    humanAdapter.enqueueDecision({ approved: true });
    expect(await scheduler.enforceRunBudget('run:lane-1:item-child', 1.5)).toEqual({ allowed: true, newLimitUsd: 2.0 });

    humanAdapter.enqueueDecision({ approved: false });
    expect(await scheduler.enforceRunBudget('run:lane-1:item-child', 1.0)).toEqual({ allowed: false });
    expect(scheduler.getItemsByKey().get('item-child')?.status).toBe('CANCELLED');

    await ledgerStore.createOrResumeRun({ runId: 'run:lane-1:item-susp', laneId: 'lane-1', itemKey: 'item-susp', inputJson: JSON.stringify({ id: 'item-susp', deps: [] }) });
    const suspRun = ledgerStore.runs.get('run:lane-1:item-susp');
    if (suspRun !== undefined) suspRun.status = 'SUSPENDED';

    const suspFlowCtx = {
      runId: 'run:lane-1:item-susp', laneId: 'lane-1', itemKey: 'item-susp', flow: flow.toAST(), currentInput: { id: 'item-susp', deps: [] },
      scopeHandle: 'root:run:lane-1:item-susp' as unknown as GitWorktreeHandle, scopeDriver: scope as never, registry, env: {}, ledgerStore, topologyStore, lessonStore,
      lockManager: new ScopeLockManager(), continuationQueue: new StepContinuationQueue(), poolManager: undefined as never,
      serviceRegistry: new ServiceSessionRegistry(), humanAdaptersById: new Map([['budget-human', humanAdapter]]),
      wirePrefixesByGroupId: new Map(), completedStepOutputs: new Map(), observedRunEffects: [],
      activeStepId: 'step-1', activeStepExecId: 'step-susp-1', activeStepAbortController: new AbortController(),
    };
    const deferredRewind = await executeHierarchicalRewindDrain({
      flowCtx: suspFlowCtx, rewindToStepId: 'step-1', updatedInput: { id: 'item-susp', deps: [], note: 'deferred' }, onRewindHook: rewindHook,
    });
    expect(deferredRewind.deferredWhileSuspended).toBe(true);
    expect(rewoundHandles).toHaveLength(0);
    expect(ledgerStore.runs.get('run:lane-1:item-susp')?.rewindPendingToStepId).toBe('step-1');

    if (suspRun !== undefined) suspRun.status = 'RUNNING';
    const liveRewind = await executeHierarchicalRewindDrain({
      flowCtx: suspFlowCtx, rewindToStepId: 'step-1', updatedInput: { id: 'item-susp', deps: [], note: 'live-rewind' }, onRewindHook: rewindHook,
    });
    expect(liveRewind.deferredWhileSuspended).toBe(false);
    expect(rewoundHandles).toEqual(['root:run:lane-1:item-susp']);

    const topologyNode = H.topology('topo-1')
      .store(SAMPLE_TOPOLOGY_STORE_NODE).partitions({ api: { dependsOn: [] } })
      .commitOverlayWhen({ onSignal: { signal: prMergedSignal, correlateBy: (p: { readonly itemKey: string }) => p.itemKey } })
      .toAST();
    const ledgerNode: SqliteLedgerNode = Object.freeze({
      type: 'sqlite:ledger', uri: ':memory:',
      compaction: Object.freeze({
        type: 'harness:compaction',
        signalTriggers: Object.freeze([{ signal: compactSignal.toAST(), correlateBy: (p: unknown) => (p as { readonly itemKey: string }).itemKey, afterGracePeriodHours: 0 }]),
        terminalExitTriggers: Object.freeze([]),
      }),
    });
    const harnessNode = H.harness('harness-1').ledger(ledgerNode).lanes(lane).toAST();

    await topologyStore.updateContract('run-base-pr', 'api', 'v2-base-pr', 'step-base');
    await topologyStore.sealRunOverlay('run-base-pr');
    await topologyStore.updateContract('run-stacked-pr', 'api', 'v3-stacked-pr', 'step-stacked');
    await topologyStore.sealRunOverlay('run-stacked-pr');
    await ledgerStore.recordRunTerminalReceipt('run-stacked-pr', 'item-stacked', 'merged', JSON.stringify({ baseBranch: 'feature/base-pr', prerequisiteRunId: 'run-base-pr' }));
    await ledgerStore.recordRunTerminalReceipt('run-base-pr', 'item-base', 'merged', JSON.stringify({ baseBranch: 'main' }));
    await lessonStore.admit({ partition: 'api', directive: 'Lesson from stacked PR', epochAtCreation: 0, createdByRunId: 'run-base-pr' });

    const runtime = createRuntime(harnessNode, { registry, topologyNode, topologyStore, lessonStore, humanAdaptersById: new Map([['budget-human', humanAdapter]]) });

    await runtime.controller.emitSignal('sig-pr-merged', { itemKey: 'item-stacked', baseBranch: 'feature/base-pr', prerequisiteRunId: 'run-base-pr' });
    expect((await topologyStore.getPartitions()).get('api')?.contractText).toBe('v1');

    await runtime.controller.emitSignal('sig-pr-merged', { itemKey: 'item-base', baseBranch: 'main' });
    expect((await topologyStore.getPartitions()).get('api')?.contractText).toBe('v3-stacked-pr');
    expect(lessonStore.lessons.get('lesson-1')?.epochAtCreation).toBe(2);

    await runtime.controller.emitSignal('sig-compact', { itemKey: 'item-base' });
    expect(ledgerStore.compactedRunIds).toEqual(['run-base-pr']);
  });
});

describe('M2 Runtime — Reboot Crash Recovery (getInterruptedStepsOnBoot, reattachRoot, reattachChild, inFlightPreToolCheckpoint)', () => {
  it('recovers mid-subprocess inFlightPreToolCheckpoint, reattaches unfinished fork/speculate child handles, and gates SUSPENDED wakeup on terminal receipts', async () => {
    const ledgerStore = new InMemoryLedgerStore();
    const scope = new ScriptedBranchableScope();
    const registry = createExecutorRegistry({ scopes: { 'git:cow-worktree': () => scope as never } });

    const rootHandle = await scope.acquireRoot('run-crash-1');
    scope.handleState.set(rootHandle, { handle: rootHandle, cleanState: true });
    const preToolCkpt = await scope.serializeCheckpoint(rootHandle);
    scope.handleState.set(rootHandle, { handle: rootHandle, cleanState: false, corruptedBySubprocess: true });

    await ledgerStore.createOrResumeRun({ runId: 'run-crash-1', laneId: 'lane-1', itemKey: 'item-crash-1', inputJson: JSON.stringify({ id: 'item-crash-1' }) });

    const forkFrame: ForkBatchContinuationFrame = Object.freeze<ForkBatchContinuationFrame>({
      kind: 'fork-batch-frame', parentStepExecId: 'step-crash-1',
      forks: Object.freeze([
        { forkId: 'fork-open', callId: 'c1', toolName: 'fork', activePartitions: [], status: 'RUNNING', conflictRetryCount: 0, conflictCheckArmed: false, suspensionEpoch: 0, continuationStack: [] },
        { forkId: 'fork-done', callId: 'c2', toolName: 'fork', activePartitions: [], status: 'CHILD_COMMITTED', conflictRetryCount: 0, conflictCheckArmed: false, suspensionEpoch: 0, continuationStack: [] },
      ]),
    });
    const specFrame: SpeculateContinuationFrame = Object.freeze<SpeculateContinuationFrame>({
      kind: 'speculate-frame', parentStepExecId: 'step-crash-1', callId: 'c-spec', toolName: 'speculate', phase: 'RACING', conflictRetryCount: 0, conflictCheckArmed: false,
      branches: Object.freeze([{ branchIndex: 0, forkId: 'spec-open', status: 'RUNNING', continuationStack: [] }, { branchIndex: 1, forkId: 'spec-won', status: 'WINNER_COMMITTED', continuationStack: [] }]),
      bufferedLessonOutcomes: Object.freeze([]), humanRulingsHistory: Object.freeze([]),
    });
    const midSubprocessAgentFrame: AgentContinuationFrame = Object.freeze<AgentContinuationFrame>({
      ...createBaseAgentFrame('step-crash-1'),
      pauseState: Object.freeze({
        kind: 'tool-batch', inFlightCallId: 'call-sub-1', inFlightPreToolCheckpoint: preToolCkpt,
        pendingToolBatch: Object.freeze({ completedResults: Object.freeze([]), blockedCalls: Object.freeze([]), remainingCalls: Object.freeze([]) }),
      }),
    });

    await ledgerStore.recordStepStart({
      runId: 'run-crash-1', stepExecId: 'step-crash-1', stepId: 'step-1', inputMsgId: null, baseScopeCheckpoint: preToolCkpt,
      continuationStack: [forkFrame, specFrame, midSubprocessAgentFrame],
    });

    const bootRecords = await ledgerStore.getInterruptedStepsOnBoot();
    expect(bootRecords).toHaveLength(1);
    const bootRecord = bootRecords[0];
    if (bootRecord === undefined) throw new Error('Expected boot record.');

    const dummyCmd = H.command('c-noop', { input: z.object({ id: z.string() }), output: z.object({ id: z.string() }), fn: async (i) => i });
    const dummyFlow = H.flow('f-crash').input(z.object({ id: z.string() })).scope(SAMPLE_TIER3_SCOPE_NODE).step('step-1', dummyCmd).exit('done').toAST();
    const flowCtx = {
      runId: 'run-crash-1', laneId: 'lane-1', itemKey: 'item-crash-1', flow: dummyFlow, currentInput: { id: 'item-crash-1' },
      scopeHandle: '' as unknown as GitWorktreeHandle, scopeDriver: scope as never, registry, env: {}, ledgerStore, lockManager: new ScopeLockManager(),
      continuationQueue: new StepContinuationQueue(), poolManager: undefined as never, serviceRegistry: new ServiceSessionRegistry(),
      humanAdaptersById: new Map(), wirePrefixesByGroupId: new Map(), completedStepOutputs: new Map(), observedRunEffects: [],
      activeStepId: 'step-1', activeStepExecId: 'step-crash-1', activeStepAbortController: new AbortController(),
    };

    const recoveryRes = await recoverInterruptedRunOnBoot({ bootRecord, flow: dummyFlow, flowCtx });
    expect(recoveryRes.readyToResume).toBe(true);
    expect(scope.restoredCheckpoints).toEqual([{ handle: 'root:run-crash-1', checkpoint: preToolCkpt }]);
    expect(scope.handleState.get('root:run-crash-1')?.['cleanState']).toBe(true);
    expect([...recoveryRes.reattachedChildHandles.keys()]).toEqual(['fork-open', 'spec-open']);

    const suspBootRecord = Object.freeze({ ...bootRecord, status: 'SUSPENDED' as const, dependsOn: Object.freeze(['dep-missing']) });
    const notReadyRes = await recoverInterruptedRunOnBoot({ bootRecord: suspBootRecord, flow: dummyFlow, flowCtx });
    expect(notReadyRes.readyToResume).toBe(false);
  });
});
