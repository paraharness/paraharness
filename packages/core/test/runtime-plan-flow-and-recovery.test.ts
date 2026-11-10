import { describe, expect, it } from 'vitest';
import {
  type AgentContinuationFrame, BudgetApprovalSchema, type FlowExecutionContext, type ForkBatchContinuationFrame,
  type GitKeepWorktreeNode, type GitWorktreeHandle, P, type InlineSkillNode, LaneScheduler,
  type LocalServiceNode, PoolManager, ScopeLockManager, ServiceSessionRegistry, type SpeculateContinuationFrame,
  type SqliteLedgerNode, StepContinuationQueue, type StepExecutionContext, createExecutorRegistry, createRuntime,
  executeAddDependencies, executeFlow, executeHierarchicalRewindDrain, executeReplaceWithPromotion,
  executeSpawnTasks, executeStepNode, executeUpdatePartitionContract, recoverInterruptedRunOnBoot, syncSuspendedRunPrerequisites, z,
} from '../src/index.js';
import { type FlowRunOptions, runFlow, runStep } from '../src/runtime/index.js';
import { InMemoryLedgerStore } from './fixtures/in-memory-ledger-store.js';
import { InMemoryLessonStore } from './fixtures/in-memory-lesson-store.js';
import { InMemoryTopologyStore } from './fixtures/in-memory-topology-store.js';
import {
  SAMPLE_ABORT_HOOK_NODE, SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE, SAMPLE_DECLARED_TOOL_NODE, SAMPLE_LEDGER_NODE,
  SAMPLE_LESSON_STORE_NODE, SAMPLE_LOCAL_COMMAND_NODE, SAMPLE_MODEL_NODE, SAMPLE_RUNNER_NODE,
  SAMPLE_TELEMETRY_COLLECTOR_NODE, SAMPLE_TIER3_SCOPE_NODE, SAMPLE_TOPOLOGY_STORE_NODE,
} from './fixtures/sample-domain-nodes.constants.js';
import { ScriptedBranchableScope } from './fixtures/scripted-branchable-scope.js';
import { ScriptedHumanAdapter } from './fixtures/scripted-human-adapter.js';
import { ScriptedModelDriver } from './fixtures/scripted-model-driver.js';
import { ScriptedServiceSession } from './fixtures/scripted-service-session.js';

const SAMPLE_SERVICE_NODE: LocalServiceNode = Object.freeze({ type: 'node:service', id: 'db-daemon', lifecycle: 'skill', toolSchemas: Object.freeze([]), runner: SAMPLE_RUNNER_NODE, ports: Object.freeze([]), startArgv: () => Object.freeze(['node', 'db.js']), interactions: Object.freeze([]) });

function throwUnusedRunner(): never {
  throw new Error('unused');
}

function createBaseAgentFrame(stepExecId: string): AgentContinuationFrame {
  return Object.freeze<AgentContinuationFrame>({
    kind: 'agent-frame', stepExecId, agentId: 'planner-agent', roleKey: 'planner-agent', modelId: 'claude-opus-4-6',
    inputJson: '{}', turnsTaken: 1, costUsd: 0.1, elapsedDurationMs: 10, leafMessageId: 'msg-1',
    activeSkillIds: Object.freeze(['skill-db']), activeSkillActivations: Object.freeze({}),
    injectedScopedRuleIds: Object.freeze([]), activeLeases: Object.freeze([]), observedEffects: Object.freeze([]),
    pausedAtPhase: 'TOOL_BOUNDARY',
    pauseState: Object.freeze({ kind: 'active-turn', pendingToolBatch: Object.freeze({ completedResults: Object.freeze([]), blockedCalls: Object.freeze([]), remainingCalls: Object.freeze([{ callId: 'call-after', toolName: 'finish', argsJson: '{}' }]) }) }),
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
      driverContext: { registry, resolveEnv: () => '', getRunner: throwUnusedRunner },
    });
    expect(daemonSession.running).toBe(true);

    const topologyBuilder = P.topology('topo-plan').store(SAMPLE_TOPOLOGY_STORE_NODE).partitions({ core: { dependsOn: [] } });
    const taskSchema = z.object({ id: z.string(), title: z.string(), tag: z.string().optional() });
    const mutatePlanCap = P.agent('planner-agent').model(SAMPLE_MODEL_NODE).input(taskSchema).output(taskSchema)
      .capabilities(($c) =>
        $c.mutatePlan(($m) =>
          $m.canSpawnTasks(taskSchema, { maxSpawnedPerRun: 3, maxPrerequisiteDepth: 4, priorityStrategy: 'inherit-parent-with-boost', enforcePatch: { tag: 'enforced-patch' }, onPrerequisiteSpawned: 'suspend-and-yield-slot', resumeWhen: 'prerequisite-exit' })
            .canAddDependencies().canUpdateTopologyContracts(topologyBuilder),
        ),
      ).toAST().capabilities?.mutatePlan;
    if (mutatePlanCap === undefined) throw new Error('Expected mutatePlan capability node.');

    await ledgerStore.createOrResumeRun({ runId: 'run-parent', laneId: 'lane-main', itemKey: 'T_parent', inputJson: JSON.stringify({ id: 'T_parent' }) });
    const initialFrame = createBaseAgentFrame('step-parent-1');
    await ledgerStore.recordStepStart({ runId: 'run-parent', stepExecId: 'step-parent-1', stepId: 'step-1', inputMsgId: null, continuationStack: [initialFrame] });

    const stepCtx: StepExecutionContext<string> = {
      runId: 'run-parent', stepExecId: 'step-parent-1', scopeHandle: parentHandle, activePartitions: ['core'],
      activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined,
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

    await expect(executeSpawnTasks({
      mutatePlanNode: mutatePlanCap, ctx: stepCtx, laneId: 'lane-main', parentItemKey: 'T_parent', parentPriority: 'normal',
      previouslySpawnedCount: 3, tasksToSpawn: [{ item: { id: 'T_3', title: 'Overflow' } }], ledgerStore,
    })).rejects.toThrow(/exceeds maxSpawnedPerRun/);

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
    const addDepRes = await executeAddDependencies({ mutatePlanNode: mutatePlanCap, ctx: stepCtx, laneId: 'lane-main', parentItemKey: 'T_parent', parentPriority: 'normal', dependencyKeysToAdd: ['T_3'], ledgerStore });
    expect(addDepRes.suspended).toBe(false);
    await expect(executeAddDependencies({ mutatePlanNode: mutatePlanCap, ctx: stepCtx, laneId: 'lane-main', parentItemKey: 'T_prevTip', dependencyKeysToAdd: ['T_2'], ledgerStore })).rejects.toThrow(/cycle/i);
    await expect(executeAddDependencies({ mutatePlanNode: Object.freeze({ ...mutatePlanCap, spawnTasks: Object.freeze({ ...(mutatePlanCap.spawnTasks as NonNullable<typeof mutatePlanCap.spawnTasks>), maxPrerequisiteDepth: 2 }) }), ctx: stepCtx, laneId: 'lane-main', parentItemKey: 'T_parent', dependencyKeysToAdd: ['T_2'], ledgerStore })).rejects.toThrow(/exceeds maxPrerequisiteDepth/);
    const failedSync = await syncSuspendedRunPrerequisites({ runId: 'run-parent', stepExecId: 'step-parent-1', prerequisiteItemKeys: ['T_3'], ledgerStore, continuationQueue: new StepContinuationQueue(), scopeHandle: parentHandle });
    expect(failedSync.allPrerequisitesSucceeded).toBe(false);
    expect(failedSync.syncNotes.some((n) => n.includes('[PREREQUISITE_FAILED]'))).toBe(true);
  });
});

describe('M2 Runtime — P.lane (syncRoot on QUEUED->RUNNING, collectFlowActors, .maxCostUsd, .retry restoreCheckpoint, Hierarchical Rewind Drain, commitOverlayWhen & compactWhen)', () => {
  it('runs initial syncRoot, collects flow actors for prefixGroups, validates nextLimit > costUsd on budget approval, restores checkpoint on .retry, and preserves overlay on rewind when resetsRunOverlay is false', async () => {
    const ledgerStore = new InMemoryLedgerStore();
    const topologyStore = new InMemoryTopologyStore({ api: { contractText: 'v1', epoch: 1 } });
    const lessonStore = new InMemoryLessonStore();
    const scope = new ScriptedBranchableScope();
    const humanAdapter = new ScriptedHumanAdapter();
    const budgetHuman = P.human('budget-human').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE).withName('budget-approver').output(BudgetApprovalSchema);
    const rewindSignal = P.signal('sig-amend', z.object({ id: z.string(), note: z.string() }));
    const prMergedSignal = P.signal('sig-pr-merged', z.object({ itemKey: z.string(), baseBranch: z.string(), prerequisiteRunId: z.string().optional() }));
    const compactSignal = P.signal('sig-compact', z.object({ itemKey: z.string() }));
    const rewoundHandles: string[] = [];
    const hookContexts: string[] = [];
    const rewindHook: GitKeepWorktreeNode = Object.freeze({ type: 'git:keep-worktree', id: 'git-keep-hook', resetsRunOverlay: false });
    const unionGroup = P.prefixGroup('pg-flow-union').toolsMode('union');

    const itemSchema = z.object({ id: z.string(), deps: z.array(z.string()).default([]), failStep2: z.boolean().optional(), note: z.string().optional() });
    let step2Attempts = 0;
    const step1Agent = P.agent<GitWorktreeHandle>('agent-step-1')
      .model(SAMPLE_MODEL_NODE).prefixGroup(unionGroup).tools(SAMPLE_DECLARED_TOOL_NODE)
      .input(itemSchema).output(z.object({ step1Done: z.boolean(), note: z.string() }));
    const step2Cmd = P.command('cmd-step-2', {
      input: itemSchema, output: z.object({ attempts: z.number() }),
      fn: async (input: z.output<typeof itemSchema>) => {
        if (input.failStep2 === true) {
          step2Attempts += 1;
          await topologyStore.updateContract(`run:lane-1:${input.id}`, 'api', `v3-step2-try-${String(step2Attempts)}`, `run:lane-1:${input.id}:step-2:${String(step2Attempts)}`);
          if (step2Attempts === 1) throw new Error('Transient step-2 failure');
        }
        return { attempts: step2Attempts };
      },
    });

    const flow = P.flow('flow-lane-1')
      .input(itemSchema).scope(SAMPLE_TIER3_SCOPE_NODE).telemetry(SAMPLE_TELEMETRY_COLLECTOR_NODE)
      .step('step-1', step1Agent).step('step-2', step2Cmd).exit('merged');
    const lane = P.lane('lane-1')
      .input(itemSchema).key((i: z.output<typeof itemSchema>) => i.id).runs(flow).concurrency(2).priority('normal').agingMinutes(10)
      .waitFor((i: z.output<typeof itemSchema>) => i.deps, 'abandoned').maxCostUsd(1.0, budgetHuman)
      .retry(($r) => $r.tries(2).exponential(0).orFail('failed'))
      .onSignal(rewindSignal, ($s) =>
        $s.update((prev: z.output<typeof itemSchema>, sig: { readonly id: string; readonly note: string }) => ({ ...prev, note: sig.note })).rewindTo('step-1', { onRewind: rewindHook }),
      );

    const modelDriver = new ScriptedModelDriver([
      { wireFrame: new Uint8Array(), canonical: { role: 'assistant', visibleText: '{"step1Done":true,"note":"initial"}', toolCalls: [] }, structuredOutput: { step1Done: true, note: 'initial' }, usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.01 } },
      { wireFrame: new Uint8Array(), canonical: { role: 'assistant', visibleText: '{"step1Done":true,"note":"initial"}', toolCalls: [] }, structuredOutput: { step1Done: true, note: 'initial' }, usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.01 } },
    ]);
    const registry = createExecutorRegistry({
      models: { 'claude:model': () => modelDriver },
      scopes: { 'git:cow-worktree': () => scope as never },
      abortHooks: { 'git:snapshot-and-reset': async (_node, input, ctx) => {
        hookContexts.push(`abort:${ctx.runId}:${String(ctx.scopeHandle)}:${String(ctx.resolveEnv({ type: 'harness:env-ref', key: 'TEST_KEY' }))}:${input.stepExecId}`);
        return { abortedSnapshotRef: 'snap-1', resetToRef: 'HEAD~1' };
      } },
      rewindHooks: { 'git:keep-worktree': async (_node, target, ctx) => {
        rewoundHandles.push(`${String(target.handle)}:${String(target.targetStepBaseScopeCheckpoint)}:${ctx.runId}:${String(ctx.resolveEnv({ type: 'harness:env-ref', key: 'TEST_KEY' }))}`);
      } },
      telemetryCollectors: { 'fs:telemetry': async (_node, _effects, ctx) => {
        hookContexts.push(`tel:${ctx.runId}:${String(ctx.scopeHandle)}:${String(ctx.resolveEnv({ type: 'harness:env-ref', key: 'TEST_KEY' }))}`);
        return { filesRead: ['a.ts'], filesMutated: [] };
      } },
      ledgers: { 'sqlite:ledger': () => ledgerStore },
    });

    const scheduler = new LaneScheduler({
      lane: lane.toAST(), registry, env: { TEST_KEY: 'env-ok' }, ledgerStore, topologyStore, lessonStore, humanAdaptersById: new Map([['budget-human', humanAdapter]]),
    });

    await scheduler.enqueueItem({ input: { id: 'item-prereq', deps: [] }, enqueuedAtMs: 1_000 });
    await scheduler.enqueueItem({ input: { id: 'item-child', deps: ['item-prereq'], failStep2: true }, enqueuedAtMs: 1_000 });
    await expect(scheduler.enqueueItem({ input: { id: 'item-self-cycle', deps: ['item-self-cycle'] } })).rejects.toThrow(/cycle/i);
    expect(scheduler.getItemsByKey().get('item-child')?.status).toBe('WAITING');

    const pass1 = await scheduler.scheduleNextReadyRuns(1_000 + 20 * 60_000);
    expect(pass1[0]?.runId).toBe('run:lane-1:item-prereq');
    expect(pass1[0]?.customTelemetry).toEqual({ filesRead: ['a.ts'], filesMutated: [] });
    expect(hookContexts).toContain('tel:run:lane-1:item-prereq:root:run:lane-1:item-prereq:env-ok');
    const compiledGroupJson = ledgerStore.runs.get('run:lane-1:item-prereq')?.compiledPrefixesJson?.['pg-flow-union'];
    expect(compiledGroupJson).toContain('fs_read');

    const restoresBeforeChild = scope.restoredCheckpoints.length;
    const origSyncRoot = scope.syncRoot.bind(scope);
    let failSyncRootOnce = true;
    scope.syncRoot = async (h, receipts) => {
      if (failSyncRootOnce) {
        failSyncRootOnce = false;
        throw new Error('syncRoot initialization failure');
      }
      return origSyncRoot(h, receipts);
    };
    await expect(scheduler.scheduleNextReadyRuns(1_000 + 20 * 60_000)).rejects.toThrow(
      'syncRoot initialization failure',
    );
    expect(scope.liveHandles.has('root:run:lane-1:item-child')).toBe(false);
    const childFailedItem = scheduler.getItemsByKey().get('item-child');
    if (childFailedItem !== undefined) {
      childFailedItem.status = 'QUEUED';
    }
    const pass2 = await scheduler.scheduleNextReadyRuns(1_000 + 20 * 60_000);
    expect(pass2[0]?.runId).toBe('run:lane-1:item-child');
    expect(step2Attempts).toBe(2);
    expect(scope.restoredCheckpoints.length).toBeGreaterThan(restoresBeforeChild);
    expect(scope.handleState.get('root:run:lane-1:item-child')?.['syncedPrerequisiteCount']).toBe(1);
    expect((await topologyStore.getPartitions('run:lane-1:item-child')).get('api')?.contractText).toBe('v3-step2-try-2');

    humanAdapter.enqueueDecision({ approved: true });
    expect(await scheduler.enforceRunBudget('run:lane-1:item-child', 1.5)).toEqual({ allowed: true, newLimitUsd: 2.0 });

    humanAdapter.enqueueDecision({ approved: true, increaseLimitToUsd: 1.2 });
    expect(await scheduler.enforceRunBudget('run:lane-1:item-child', 1.5)).toEqual({ allowed: false });
    expect(scheduler.getItemsByKey().get('item-child')?.status).toBe('CANCELLED');

    await ledgerStore.createOrResumeRun({ runId: 'run:lane-1:item-susp', laneId: 'lane-1', itemKey: 'item-susp', inputJson: JSON.stringify({ id: 'item-susp', deps: [] }) });
    await ledgerStore.recordForkSuspension({
      suspendedForkId: 'f-rew#1', forkId: 'f-rew', suspensionEpoch: 1, runId: 'run:lane-1:item-susp',
      parentStepExecId: 'step-susp-1', forkToolName: 'fork', activePartitions: ['api'], suspensionReason: 'INTERRUPT_RAISED', conflictRetryCount: 0, conflictCheckArmed: false, continuationStack: [],
    });
    await topologyStore.updateContract('run:lane-1:item-susp', 'api', 'v2-kept-on-rewind', 'step-susp-1');
    const suspRun = ledgerStore.runs.get('run:lane-1:item-susp');
    if (suspRun !== undefined) suspRun.status = 'SUSPENDED';

    const suspFlowCtx: FlowExecutionContext<unknown, unknown> = {
      runId: 'run:lane-1:item-susp', laneId: 'lane-1', itemKey: 'item-susp', flow: flow.toAST() as never, currentInput: { id: 'item-susp', deps: [] },
      scopeHandle: 'root:run:lane-1:item-susp', scopeDriver: scope as never, registry, env: { TEST_KEY: 'env-ok' }, ledgerStore, topologyStore, lessonStore,
      lockManager: new ScopeLockManager(), continuationQueue: new StepContinuationQueue(), poolManager: new PoolManager(),
      serviceRegistry: new ServiceSessionRegistry(), humanAdaptersById: new Map([['budget-human', humanAdapter]]),
      wirePrefixesByGroupId: new Map(), completedStepOutputs: new Map(), stepBaseCheckpointsByStepId: new Map([['step-1', 'ckpt:step-1-base']]), observedRunEffects: [],
      activeStepId: 'step-1', activeStepExecId: 'step-susp-1', activeStepAbortController: new AbortController(),
    };
    const deferredRewind = await executeHierarchicalRewindDrain({ flowCtx: suspFlowCtx, rewindToStepId: 'step-1', updatedInput: { id: 'item-susp', deps: [], note: 'deferred' }, onRewindHook: rewindHook });
    expect([deferredRewind.deferredWhileSuspended, rewoundHandles.length, ledgerStore.runs.get('run:lane-1:item-susp')?.rewindPendingToStepId]).toEqual([true, 0, 'step-1']);

    if (suspRun !== undefined) suspRun.status = 'RUNNING';
    const liveRewind = await executeHierarchicalRewindDrain({ flowCtx: suspFlowCtx, rewindToStepId: 'step-1', updatedInput: { id: 'item-susp', deps: [], note: 'live-rewind' }, onRewindHook: rewindHook });
    expect([liveRewind.deferredWhileSuspended, rewoundHandles, ledgerStore.resolvedSuspendedForks.get('f-rew#1')]).toEqual([false, ['root:run:lane-1:item-susp:ckpt:step-1-base:run:lane-1:item-susp:env-ok'], 'ABORTED']);
    expect([scope.reattachedHandles.includes('root:run:lane-1:item-susp/child:f-rew'), scope.liveHandles.has('root:run:lane-1:item-susp/child:f-rew')]).toEqual([true, false]);
    expect([(await topologyStore.getPartitions('run:lane-1:item-susp')).get('api')?.contractText, ledgerStore.runs.get('run:lane-1:item-susp')?.rewindPendingToStepId]).toEqual(['v2-kept-on-rewind', undefined]);

    await executeHierarchicalRewindDrain({ flowCtx: suspFlowCtx, rewindToStepId: 'step-1', updatedInput: { id: 'item-susp', deps: [], note: 'default-restore' } });
    expect(scope.restoredCheckpoints.at(-1)).toEqual({ handle: 'root:run:lane-1:item-susp', checkpoint: 'ckpt:step-1-base' });
    await ledgerStore.recordForkSuspension({
      suspendedForkId: 'f-rep#1', forkId: 'f-rep', suspensionEpoch: 1, runId: 'run:lane-1:item-susp',
      parentStepExecId: 'step-susp-1', forkToolName: 'fork', activePartitions: ['api'], suspensionReason: 'INTERRUPT_RAISED', conflictRetryCount: 0, conflictCheckArmed: false, continuationStack: [],
    });
    await executeReplaceWithPromotion({ flowCtx: suspFlowCtx, stepExecId: 'step-susp-1', stepId: 'step-1', baseScopeCheckpoint: 'ckpt:step-1-base', replacementExecutable: step2Cmd.toAST(), replacementInput: { id: 'item-susp', deps: [] }, abortHook: SAMPLE_ABORT_HOOK_NODE });
    expect(hookContexts).toContain('abort:run:lane-1:item-susp:root:run:lane-1:item-susp:env-ok:step-susp-1');
    expect([ledgerStore.resolvedSuspendedForks.get('f-rep#1'), scope.reattachedHandles.includes('root:run:lane-1:item-susp/child:f-rep'), scope.liveHandles.has('root:run:lane-1:item-susp/child:f-rep')]).toEqual(['ABORTED', true, false]);

    const topologyNode = P.topology('topo-1').store(SAMPLE_TOPOLOGY_STORE_NODE).partitions({ api: { dependsOn: [] } }).commitOverlayWhen({ onSignal: { signal: prMergedSignal, correlateBy: (p: { readonly itemKey: string }) => p.itemKey } }).toAST();
    const ledgerNode: SqliteLedgerNode = Object.freeze({
      type: 'sqlite:ledger', uri: ':memory:',
      compaction: Object.freeze({ type: 'harness:compaction', signalTriggers: Object.freeze([{ signal: compactSignal.toAST(), correlateBy: (p: unknown) => (p as { readonly itemKey: string }).itemKey, afterGracePeriodHours: 0 }]), terminalExitTriggers: Object.freeze([]) }),
    });
    const harnessNode = P.harness('harness-1').ledger(ledgerNode).lanes(lane).toAST();

    await topologyStore.updateContract('run-base-pr', 'api', 'v2-base-pr', 'step-base');
    await topologyStore.sealRunOverlay('run-base-pr');
    await topologyStore.updateContract('run-stacked-pr', 'api', 'v3-stacked-pr', 'step-stacked');
    await topologyStore.sealRunOverlay('run-stacked-pr');
    await ledgerStore.recordRunTerminalReceipt('run-stacked-pr', 'item-stacked', 'merged', JSON.stringify({ baseBranch: 'feature/base-pr', prerequisiteRunId: 'run-base-pr' }));
    await ledgerStore.recordRunTerminalReceipt('run-base-pr', 'item-base', 'merged', JSON.stringify({ baseBranch: 'main' }));
    await lessonStore.admit({ partition: 'api', directive: 'Lesson from stacked PR', epochAtCreation: 0, createdByRunId: 'run-base-pr' });

    let bootQueryCalled = false;
    const origGetBoot = ledgerStore.getInterruptedStepsOnBoot.bind(ledgerStore);
    ledgerStore.getInterruptedStepsOnBoot = async () => ((bootQueryCalled = true), origGetBoot());
    const runtime = createRuntime(harnessNode, { registry, topologyNode, topologyStore, lessonStore, humanAdaptersById: new Map([['budget-human', humanAdapter]]) });
    await runtime.start();
    expect(bootQueryCalled).toBe(true);
    await runtime.stop();

    await runtime.controller.emitSignal('sig-pr-merged', { itemKey: 'item-stacked', baseBranch: 'feature/base-pr', prerequisiteRunId: 'run-base-pr' });
    expect((await topologyStore.getPartitions()).get('api')?.contractText).toBe('v1');
    await runtime.controller.emitSignal('sig-pr-merged', { itemKey: 'item-base', baseBranch: 'main' });
    expect([(await topologyStore.getPartitions()).get('api')?.contractText, lessonStore.lessons.get('lesson-1')?.epochAtCreation]).toEqual(['v3-stacked-pr', 2]);
    await runtime.controller.emitSignal('sig-compact', { itemKey: 'item-base' });
    expect(ledgerStore.compactedRunIds).toEqual(['run-base-pr']);
  });
});

describe('M2 Runtime — Reboot Crash Recovery (getInterruptedStepsOnBoot, reattachRoot, reattachChild, inFlightPreToolCheckpoint)', () => {
  it('recovers mid-subprocess inFlightPreToolCheckpoint, reattaches unfinished fork/speculate child handles, applies deferred rewindPendingToStepId, and resumes RUNNING steps at bootRecord.stepId', async () => {
    const ledgerStore = new InMemoryLedgerStore();
    const topologyStore = new InMemoryTopologyStore({ api: { contractText: 'v1', epoch: 1 } });
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
      runId: 'run-crash-1', stepExecId: 'step-crash-1', stepId: 'step-2', inputMsgId: null, baseScopeCheckpoint: preToolCkpt,
      continuationStack: [forkFrame, specFrame, midSubprocessAgentFrame],
    });

    const bootRecords = await ledgerStore.getInterruptedStepsOnBoot();
    expect(bootRecords).toHaveLength(1);
    const bootRecord = bootRecords[0];
    if (bootRecord === undefined) throw new Error('Expected boot record.');

    const executedSteps: string[] = [];
    let triggerRewindOnce = true;
    const step1Cmd = P.command('c-s1', { input: z.object({ id: z.string() }), output: z.object({ id: z.string() }), fn: async (i) => ((executedSteps.push('step-1')), i) });
    const step2Cmd = P.command('c-s2', {
      input: z.object({ id: z.string() }), output: z.object({ id: z.string() }),
      fn: async (i) => {
        executedSteps.push('step-2');
        if (triggerRewindOnce) flowCtx.pendingRewindToStepId = ((triggerRewindOnce = false), 'step-1');
        return i;
      },
    });
    const dummyFlow = P.flow('f-crash').input(z.object({ id: z.string() })).scope(SAMPLE_TIER3_SCOPE_NODE).step('step-1', step1Cmd).step('step-2', step2Cmd).exit('done').toAST();
    const flowCtx: FlowExecutionContext<unknown, unknown> = {
      runId: 'run-crash-1', laneId: 'lane-1', itemKey: 'item-crash-1', flow: dummyFlow as never, currentInput: { id: 'item-crash-1' },
      scopeHandle: '', scopeDriver: scope as never, registry, env: {}, ledgerStore, topologyStore, lockManager: new ScopeLockManager(),
      continuationQueue: new StepContinuationQueue(), poolManager: new PoolManager(), serviceRegistry: new ServiceSessionRegistry(),
      humanAdaptersById: new Map(), wirePrefixesByGroupId: new Map(), completedStepOutputs: new Map([['step-1', { id: 'stale-s1' }], ['step-2', { id: 'stale-s2' }]]), observedRunEffects: [],
      activeStepId: null, activeStepExecId: null, activeStepAbortController: new AbortController(),
    };

    const recoveryRes = await recoverInterruptedRunOnBoot({ bootRecord, flow: dummyFlow as never, flowCtx });
    expect([recoveryRes.readyToResume, flowCtx.activeStepId, flowCtx.activeStepExecId]).toEqual([true, 'step-2', 'step-crash-1']);
    expect([scope.restoredCheckpoints, scope.handleState.get('root:run-crash-1')?.['cleanState'], [...recoveryRes.reattachedChildHandles.keys()]]).toEqual([
      [{ handle: 'root:run-crash-1', checkpoint: preToolCkpt }], true, ['fork-open', 'spec-open'],
    ]);
    await executeFlow(flowCtx);
    expect(executedSteps).toEqual(['step-2', 'step-1', 'step-2']);

    await ledgerStore.updateRunInput('run-crash-1', { inputJson: JSON.stringify({ id: 'item-crash-1' }), rewindPendingToStepId: 'step-1' });
    await topologyStore.updateContract('run-crash-1', 'api', 'v2-uncommitted', 'step-crash-1');
    await ledgerStore.recordForkSuspension({
      suspendedForkId: 'f-boot-rew#1', forkId: 'f-boot-rew', suspensionEpoch: 1, runId: 'run-crash-1',
      parentStepExecId: 'step-crash-1', forkToolName: 'fork', activePartitions: ['api'], suspensionReason: 'INTERRUPT_RAISED', conflictRetryCount: 0, conflictCheckArmed: false, continuationStack: [],
    });
    const suspReadyRecord = Object.freeze({ ...bootRecord, status: 'SUSPENDED' as const, dependsOn: Object.freeze([]) });
    const suspReadyRes = await recoverInterruptedRunOnBoot({ bootRecord: suspReadyRecord, flow: dummyFlow as never, flowCtx });
    expect([suspReadyRes.readyToResume, flowCtx.pendingRewindToStepId, flowCtx.activeStepId, ledgerStore.resolvedSuspendedForks.get('f-boot-rew#1'), (await topologyStore.getPartitions('run-crash-1')).get('api')?.contractText, ledgerStore.runs.get('run-crash-1')?.rewindPendingToStepId]).toEqual([
      true, 'step-1', 'step-1', 'ABORTED', 'v1', undefined,
    ]);

    const suspBootRecord = Object.freeze({ ...bootRecord, status: 'SUSPENDED' as const, dependsOn: Object.freeze(['dep-missing']) });
    const notReadyRes = await recoverInterruptedRunOnBoot({ bootRecord: suspBootRecord, flow: dummyFlow as never, flowCtx });
    expect(notReadyRes.readyToResume).toBe(false);
    const domainCmd = Object.freeze({ ...SAMPLE_LOCAL_COMMAND_NODE, inputSchema: z.object({ arg: z.string() }) });
    const makeDomCtx = (exitCode: number): StepExecutionContext<GitWorktreeHandle> => ({ runId: 'run-crash-1', stepExecId: 'step-dom-1', scopeHandle: 'root:run-crash-1' as never, activePartitions: [], activeLeases: [], observedEffects: [], registry: createExecutorRegistry({ steps: { 'node:command': async () => ({ exitCode }) } }), resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined });
    await Promise.all([expect(executeStepNode(domainCmd, { arg: 'ok' }, makeDomCtx(0))).resolves.toEqual({ exitCode: 0 }), expect(executeStepNode(domainCmd, { arg: 'ok' }, { ...makeDomCtx(0), registry: createExecutorRegistry() })).rejects.toThrow(/step id 'shell-cmd'/), expect(executeStepNode(domainCmd, { arg: 123 as never }, makeDomCtx(0))).rejects.toThrow(/expected string/i), expect(executeStepNode(domainCmd, { arg: 'ok' }, makeDomCtx('bad' as never))).rejects.toThrow(/expected number/i)]);
  });
});

describe('M2 Runtime — runFlow standalone flow runner (P2)', () => {
  it('auto-resolves ledger, scope, topology, lessons, and human adapters from registry, executes flow, and releases scope in finally even on error', async () => {
    const ledgerStore = new InMemoryLedgerStore();
    const topologyStore = new InMemoryTopologyStore({ core: { contractText: 'Contract v1', epoch: 1 } });
    const lessonStore = new InMemoryLessonStore([
      {
        id: 'L1',
        partition: 'core',
        directive: 'Remember lesson 1',
        epochAtCreation: 1,
        recentOutcomes: ['clean_pass', 'clean_pass'],
        totalCleanPasses: 5,
        totalViolated: 0,
        signalLastEmittedAt: {},
        relevanceScore: 1,
      },
    ]);
    const scope = new ScriptedBranchableScope();
    const humanAdapter = new ScriptedHumanAdapter([{ approved: true }]);
    const modelDriver = new ScriptedModelDriver([
      {
        wireFrame: new Uint8Array(),
        canonical: {
          role: 'assistant',
          visibleText: 'ask human',
          toolCalls: [{ id: 'tc-esc', name: 'ask_human', argsJson: JSON.stringify({ q: 'ok?' }) }],
        },
        usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.01 },
      },
      {
        wireFrame: new Uint8Array(),
        canonical: { role: 'assistant', visibleText: JSON.stringify({ done: true }), toolCalls: [] },
        structuredOutput: { done: true },
        usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.01 },
      },
    ]);

    const topo = P.topology('flow-topo').store(SAMPLE_TOPOLOGY_STORE_NODE).partitions({ core: { dependsOn: [] } });
    const lessons = P.lessons('flow-lessons').store(SAMPLE_LESSON_STORE_NODE);
    const human = P.human('flow-human').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE);
    const escIntr = P.interrupt('ask_human', z.object({ q: z.string() }));

    const worker = P.agent<string>('flow-worker')
      .model(SAMPLE_MODEL_NODE)
      .topology(topo)
      .lessons(lessons)
      .input(z.object({ id: z.string() }))
      .partitions(() => ['core'])
      .output(z.object({ done: z.boolean() }))
      .canRaise(escIntr)
      .onInterrupt(escIntr, ($intr) =>
        $intr.ask(human, z.object({ approved: z.boolean() })).resumeWith((dec) => JSON.stringify(dec)),
      );

    const flowBuilder = P.flow('standalone-flow')
      .input(z.object({ id: z.string() }))
      .scope(SAMPLE_TIER3_SCOPE_NODE as never)
      .step('work', worker)
      .exit('done');

    const options: FlowRunOptions = {
      registry: [
        {
          ledgers: { 'sqlite:ledger': () => ledgerStore },
          scopes: { 'git:cow-worktree': () => scope as never },
          topologies: { 'sqlite:topology': () => topologyStore },
          lessons: { 'sqlite:lessons': () => lessonStore },
          humanChannels: { 'slack:approver': () => humanAdapter },
          models: { 'claude:model': () => modelDriver },
        },
      ],
      ledger: SAMPLE_LEDGER_NODE,
    };

    const res = await runFlow(flowBuilder, { id: 'item-42' }, options);
    expect(res.exitState).toBe('done');
    expect(res.stepOutputs).toEqual({ work: { done: true } });
    expect(scope.handleState.has('root:standalone-flow-run')).toBe(true);
    expect(scope.liveHandles.has('root:standalone-flow-run')).toBe(false);
    expect(modelDriver.recordedRequests[0]?.history[0]?.canonical.visibleText).toContain('Contract v1');
    expect(modelDriver.recordedRequests[0]?.history[0]?.canonical.visibleText).toContain('Remember lesson 1');
    expect(humanAdapter.decisionRequests).toHaveLength(1);

    const failStep = P.command<string>('boom-step')
      .input(z.object({ id: z.string() }))
      .output(z.object({}))
      .run(async () => {
        throw new Error('Step boom');
      });
    const failingFlow = P.flow('failing-flow')
      .input(z.object({ id: z.string() }))
      .scope(SAMPLE_TIER3_SCOPE_NODE as never)
      .step('boom', failStep)
      .exit('done');

    await expect(
      runFlow(failingFlow, { id: 'item-fail' }, { ...options, runId: 'fail-run-1' }),
    ).rejects.toThrow('Step boom');
    expect(scope.handleState.has('root:fail-run-1')).toBe(true);
    expect(scope.liveHandles.has('root:fail-run-1')).toBe(false);

    await expect(
      runFlow(flowBuilder, { id: 'item-missing' }, { registry: {}, ledger: SAMPLE_LEDGER_NODE }),
    ).rejects.toThrow(/No LedgerStore registered for 'sqlite:ledger'/);
  });
});

describe('M2 Runtime — createRuntime registry slice array & auto-resolved stores/humans (P9)', () => {
  it('accepts an array of registry slices and auto-resolves TopologyNode, LessonsNode, and HumanNode from harness lanes and flows', async () => {
    const ledgerStore = new InMemoryLedgerStore();
    const topologyStore = new InMemoryTopologyStore({ api: { contractText: 'contract-v1', epoch: 1 } });
    const lessonStore = new InMemoryLessonStore();
    const humanAdapter = new ScriptedHumanAdapter();
    const scope = new ScriptedBranchableScope();

    const prMergedSig = P.signal('p9-pr-merged', z.object({ itemKey: z.string() }));
    const topologyNode = P.topology('p9-topo')
      .store(SAMPLE_TOPOLOGY_STORE_NODE)
      .partitions({ api: { dependsOn: [] } })
      .commitOverlayWhen({
        onSignal: {
          signal: prMergedSig,
          correlateBy: (p: { readonly itemKey: string }) => p.itemKey,
        },
      });
    const lessonsNode = P.lessons('p9-lessons').store(SAMPLE_LESSON_STORE_NODE);
    const humanNode = P.human('p9-approver').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE);
    const workerAgent = P.agent<string>('p9-worker')
      .model(SAMPLE_MODEL_NODE)
      .topology(topologyNode)
      .lessons(lessonsNode)
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.boolean() }))
      .onInterrupt(P.interrupt('p9-esc'), ($i) =>
        $i.ask(humanNode, z.object({ approved: z.boolean() })).resumeWith((d) => String(d.approved)),
      );
    const flow = P.flow('p9-flow')
      .input(z.object({ id: z.string() }))
      .scope(SAMPLE_TIER3_SCOPE_NODE as never)
      .step('work', workerAgent)
      .exit('done');
    const lane = P.lane('p9-lane')
      .input(z.object({ id: z.string() }))
      .key((i) => i.id)
      .maxCostUsd(5, humanNode.withName('budget-approver').output(BudgetApprovalSchema))
      .runs(flow);
    const harness = P.harness('p9-harness').ledger(SAMPLE_LEDGER_NODE).lanes(lane);

    await topologyStore.updateContract('run-p9-1', 'api', 'contract-v2', 'step-1');
    await topologyStore.sealRunOverlay('run-p9-1');
    await ledgerStore.recordRunTerminalReceipt(
      'run-p9-1',
      'item-p9-1',
      'done',
      JSON.stringify({ baseBranch: 'main' }),
    );
    await lessonStore.admit({
      partition: 'api',
      directive: 'Lesson for p9',
      epochAtCreation: 0,
      createdByRunId: 'run-p9-1',
    });

    const runtime = createRuntime(harness, {
      registry: [
        { ledgers: { 'sqlite:ledger': () => ledgerStore } },
        { scopes: { 'git:cow-worktree': () => scope as never } },
        { topologies: { 'sqlite:topology': () => topologyStore } },
        { lessons: { 'sqlite:lessons': () => lessonStore } },
        { humanChannels: { 'slack:approver': () => humanAdapter } },
      ],
    });
    await runtime.start();
    await runtime.controller.emitSignal('p9-pr-merged', { itemKey: 'item-p9-1' });
    expect((await topologyStore.getPartitions()).get('api')?.contractText).toBe('contract-v2');
    expect(lessonStore.lessons.get('lesson-1')?.epochAtCreation).toBe(2);
    await runtime.stop();

    expect(() =>
      createRuntime(harness, {
        registry: [
          { ledgers: { 'sqlite:ledger': () => ledgerStore } },
          { scopes: { 'git:cow-worktree': () => scope as never } },
          { topologies: { 'sqlite:topology': () => topologyStore } },
          { humanChannels: { 'slack:approver': () => humanAdapter } },
        ],
      }),
    ).toThrow(/No LessonStore registered for 'sqlite:lessons'/);
  });
});

describe('M2 Runtime — controller.emitSignal with SignalBuilder and SignalNode (P10)', () => {
  it('accepts SignalBuilder, SignalNode, and string signalId and validates payload against signalNode.schema', async () => {
    const ledgerStore = new InMemoryLedgerStore();
    const humanAdapter = new ScriptedHumanAdapter();
    const prMergedSig = P.signal('p10-pr-merged', z.object({ itemKey: z.string().min(1) }));
    const humanNode = P.human('p10-notifier').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE);
    const harness = P.harness('p10-harness')
      .ledger(SAMPLE_LEDGER_NODE)
      .onSignal(prMergedSig, ($s) =>
        $s.notify(humanNode, (payload) => `Merged:${payload.itemKey}`),
      );

    const runtime = createRuntime(harness, {
      registry: {
        ledgers: { 'sqlite:ledger': () => ledgerStore },
        humanChannels: { 'slack:approver': () => humanAdapter },
      },
    });
    await runtime.start();

    await runtime.controller.emitSignal(prMergedSig, { itemKey: 'item-builder' });
    await runtime.controller.emitSignal(prMergedSig.toAST(), { itemKey: 'item-node' });
    await runtime.controller.emitSignal('p10-pr-merged', { itemKey: 'item-string' });

    expect(humanAdapter.notifications).toEqual([
      'Merged:item-builder',
      'Merged:item-node',
      'Merged:item-string',
    ]);

    await expect(
      runtime.controller.emitSignal(prMergedSig, { itemKey: '' }),
    ).rejects.toThrow();

    await runtime.stop();
  });

  it('validates all TopologyNode, LessonsNode, and nested flow-step interrupt HumanNode declarations, allows omitting scopeHandle in runStep, and cleans up abort listeners if acquireRoot rejects (VF-2, VF-3, VF-5)', async () => {
    const cmdStep = P.command('vf3-cmd')
      .input(z.object({ x: z.number() }))
      .output(z.object({ doubled: z.number() }))
      .run(async (input: { readonly x: number }) => ({
        doubled: input.x * 2,
      }));
    const stepOut = await runStep(cmdStep, { x: 21 }, { registry: {} });
    expect(stepOut).toEqual({ doubled: 42 });

    const ledgerStore = new InMemoryLedgerStore();
    const topologyStore = new InMemoryTopologyStore({ api: { contractText: 'v1', epoch: 1 } });
    const lessonStore = new InMemoryLessonStore();
    const scope = new ScriptedBranchableScope();
    const primaryTopo = P.topology('topo-1')
      .store(SAMPLE_TOPOLOGY_STORE_NODE)
      .partitions({ api: {} });
    const secondaryTopo = P.topology('topo-2')
      .store({ type: 'postgres:topology', uri: 'postgres://localhost:5432/db' })
      .partitions({ api: {} });
    const primaryLessons = P.lessons('lessons-1')
      .store(SAMPLE_LESSON_STORE_NODE)
      .queryFrom(z.object({ x: z.number() }), (v) => String(v.x))
      .distillWith(SAMPLE_MODEL_NODE, ($d) => $d.onLoopRecovery());
    const secondaryLessons = P.lessons('lessons-2')
      .store({
        type: 'fs:jsonl-lesson-store',
        definitionsDir: '.paraharness/lessons',
        statsPath: '.paraharness/lessons-stats.json',
        lockFile: '.paraharness/lessons.lock',
      })
      .queryFrom(z.object({ x: z.number() }), (v) => String(v.x))
      .distillWith(SAMPLE_MODEL_NODE, ($d) => $d.onLoopRecovery());

    const step1 = P.agent('agent-1')
      .model(SAMPLE_MODEL_NODE)
      .topology(primaryTopo)
      .lessons(primaryLessons)
      .input(z.object({ x: z.number() }))
      .output(z.object({ x: z.number() }));
    const step2 = P.agent('agent-2')
      .model(SAMPLE_MODEL_NODE)
      .topology(secondaryTopo)
      .lessons(secondaryLessons)
      .input(z.object({ x: z.number() }))
      .output(z.object({ x: z.number() }));
    const flowWithTwoTopos = P.flow('flow-two-topos')
      .input(z.object({ x: z.number() }))
      .scope(SAMPLE_TIER3_SCOPE_NODE)
      .step('s1', step1)
      .step('s2', step2)
      .exit('s2');

    await expect(
      runFlow(
        flowWithTwoTopos,
        { x: 1 },
        {
          ledger: SAMPLE_LEDGER_NODE,
          registry: {
            ledgers: { 'sqlite:ledger': () => ledgerStore },
            scopes: { 'git:cow-worktree': () => scope as never },
            topologies: { 'sqlite:topology': () => topologyStore },
            lessons: { 'sqlite:lessons': () => lessonStore },
          },
        },
      ),
    ).rejects.toThrow(/No TopologyStore registered for 'postgres:topology'/);

    await expect(
      runFlow(
        flowWithTwoTopos,
        { x: 1 },
        {
          ledger: SAMPLE_LEDGER_NODE,
          registry: {
            ledgers: { 'sqlite:ledger': () => ledgerStore },
            scopes: { 'git:cow-worktree': () => scope as never },
            topologies: {
              'sqlite:topology': () => topologyStore,
              'postgres:topology': () => topologyStore,
            },
            lessons: { 'sqlite:lessons': () => lessonStore },
          },
        },
      ),
    ).rejects.toThrow(/No LessonStore registered for 'fs:jsonl-lesson-store'/);

    const intr = P.interrupt('flow-intr', z.object({ reason: z.string() }));
    const humanInReplace = P.human('replace-human').notify(
      SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE,
    );
    const replacementAgent = P.agent('replacement-agent')
      .model(SAMPLE_MODEL_NODE)
      .input(z.object({ x: z.number() }))
      .output(z.object({ x: z.number() }))
      .onInterrupt(intr, ($i) =>
        $i
          .ask(humanInReplace, z.object({ approved: z.boolean() }))
          .resumeWith((res) => String(res.approved)),
      );
    const workerRaising = P.agent('worker-raising')
      .model(SAMPLE_MODEL_NODE)
      .input(z.object({ x: z.number() }))
      .output(z.object({ x: z.number() }))
      .canRaise(intr);
    const flowWithReplaceHuman = P.flow('flow-replace-human')
      .input(z.object({ x: z.number() }))
      .scope(SAMPLE_TIER3_SCOPE_NODE)
      .step('s1', workerRaising, ($edge) =>
        $edge.onInterrupt(intr, ($i) =>
          $i.replaceWith(replacementAgent, (inVal) => inVal),
        ),
      )
      .exit('s1');

    await expect(
      runFlow(
        flowWithReplaceHuman,
        { x: 1 },
        {
          ledger: SAMPLE_LEDGER_NODE,
          registry: {
            ledgers: { 'sqlite:ledger': () => ledgerStore },
            scopes: { 'git:cow-worktree': () => scope as never },
          },
        },
      ),
    ).rejects.toThrow(/No HumanAdapter registered for 'slack:approver'/);

    const abortController = new AbortController();
    let activeAbortListeners = 0;
    const origAdd = abortController.signal.addEventListener.bind(abortController.signal);
    const origRemove = abortController.signal.removeEventListener.bind(abortController.signal);
    abortController.signal.addEventListener = ((
      ...args: Parameters<AbortSignal['addEventListener']>
    ): void => {
      activeAbortListeners += 1;
      origAdd(...args);
    }) as AbortSignal['addEventListener'];
    abortController.signal.removeEventListener = ((
      ...args: Parameters<AbortSignal['removeEventListener']>
    ): void => {
      activeAbortListeners -= 1;
      origRemove(...args);
    }) as AbortSignal['removeEventListener'];

    const simpleFlow = P.flow('simple-abort-leak-flow')
      .input(z.object({ x: z.number() }))
      .scope(SAMPLE_TIER3_SCOPE_NODE)
      .step('s1', cmdStep)
      .exit('s1');

    await expect(
      runFlow(
        simpleFlow,
        { x: 5 },
        {
          ledger: SAMPLE_LEDGER_NODE,
          signal: abortController.signal,
          registry: {
            ledgers: { 'sqlite:ledger': () => ledgerStore },
            scopes: {
              'git:cow-worktree': () => ({
                acquireRoot: async () => {
                  throw new Error('acquireRoot boom');
                },
                release: async () => {},
              }) as never,
            },
          },
        },
      ),
    ).rejects.toThrow('acquireRoot boom');
    expect(activeAbortListeners).toBe(0);
  });

  it('enqueues items via controller.enqueue, recovers boot runs and polls trackers on runtime.start(), wakes dependent runs, and memoizes getRunner with conflict validation (ADJ-1, ADJ-2, ADJ-9)', async () => {
    const ledgerStore = new InMemoryLedgerStore();
    const scope = new ScriptedBranchableScope();
    const executedKeys: string[] = [];
    let runnerFactoryCount = 0;

    const itemSchema = z.object({
      id: z.string(),
      dependsOn: z.array(z.string()).optional(),
    });

    const stepCmd = P.command('adj-step')
      .input(itemSchema)
      .output(z.object({ done: z.string() }))
      .run(async (input, ctx) => {
        ctx.getRunner(SAMPLE_RUNNER_NODE);
        ctx.getRunner({ ...SAMPLE_RUNNER_NODE });
        executedKeys.push(input.id);
        return { done: input.id };
      });

    const flow = P.flow('adj-flow')
      .input(itemSchema)
      .scope(SAMPLE_TIER3_SCOPE_NODE)
      .step('s1', stepCmd)
      .exit('done');

    const lane = P.lane('adj-lane')
      .input(itemSchema)
      .key((item) => item.id)
      .waitFor((item) => item.dependsOn ?? [], 'blocked-on-prereq')
      .runs(flow);

    await ledgerStore.createOrResumeRun({
      runId: 'run:adj-lane:boot-item',
      laneId: 'adj-lane',
      itemKey: 'boot-item',
      inputJson: JSON.stringify({ id: 'boot-item' }),
    });
    await ledgerStore.recordStepStart({
      runId: 'run:adj-lane:boot-item',
      stepExecId: 'exec-boot-1',
      stepId: 's1',
      executableId: 'adj-step',
      inputMsgId: null,
      continuationStack: [],
    });

    const harness = P.harness('adj-harness')
      .ledger(SAMPLE_LEDGER_NODE)
      .pools(SAMPLE_RUNNER_NODE)
      .lanes(lane);

    const runtime = createRuntime(harness, {
      registry: {
        ledgers: { 'sqlite:ledger': () => ledgerStore },
        scopes: {
          'git:cow-worktree': (sNode, dCtx) => {
            void sNode;
            dCtx.getRunner(SAMPLE_RUNNER_NODE);
            return scope as never;
          },
        },
        runners: {
          'node:runner': () => {
            runnerFactoryCount += 1;
            return {
              id: 'runner-1',
              withSlot: async (fn) => fn(),
              withDaemonSlot: async (fn) => fn(() => {}),
            };
          },
        },
      },
    });

    await runtime.start();
    expect(executedKeys).toEqual(['boot-item']);

    await runtime.controller.enqueue(lane, { id: 'child-item', dependsOn: ['prereq-item'] });
    expect(executedKeys).toEqual(['boot-item']);

    await runtime.controller.enqueue('adj-lane', { id: 'prereq-item' });
    expect(executedKeys).toEqual(['boot-item', 'prereq-item', 'child-item']);
    expect(runnerFactoryCount).toBe(1);

    await expect(
      runtime.controller.enqueue('missing-lane', { id: 'x' }),
    ).rejects.toThrow("Unknown lane 'missing-lane' in HarnessRuntimeController.enqueue on harness 'adj-harness'.");

    await runtime.stop();

    const spawnLedger = new InMemoryLedgerStore();
    const spawnScope = new ScriptedBranchableScope();
    const spawnExecuted: string[] = [];
    const spawnModelDriver = new ScriptedModelDriver([
      {
        wireFrame: new Uint8Array(),
        canonical: {
          role: 'assistant',
          visibleText: 'spawn child',
          toolCalls: [
            {
              id: 'tc-spawn-1',
              name: 'spawnTasks',
              argsJson: JSON.stringify({ tasks: [{ item: { id: 'spawned-child' } }] }),
            },
          ],
        },
        usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.01 },
      },
      {
        wireFrame: new Uint8Array(),
        canonical: {
          role: 'assistant',
          visibleText: JSON.stringify({ done: 'spawned-child' }),
          toolCalls: [],
        },
        structuredOutput: { done: 'spawned-child' },
        usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.01 },
      },
      {
        wireFrame: new Uint8Array(),
        canonical: {
          role: 'assistant',
          visibleText: JSON.stringify({ done: 'spawn-parent' }),
          toolCalls: [],
        },
        structuredOutput: { done: 'spawn-parent' },
        usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.01 },
      },
    ]);
    const spawnAgent = P.agent<string>('spawn-agent')
      .model(SAMPLE_MODEL_NODE)
      .input(itemSchema)
      .output(z.object({ done: z.string() }))
      .capabilities(($c) =>
        $c.mutatePlan(($m) => $m.canSpawnTasks(itemSchema, { maxSpawnedPerRun: 2 })),
      );
    const recordCmd = P.command('record-cmd')
      .input(itemSchema)
      .output(z.object({ done: z.string() }))
      .run(async (input) => {
        spawnExecuted.push(input.id);
        return { done: input.id };
      });
    const spawnFlow = P.flow('spawn-flow')
      .input(itemSchema)
      .scope(SAMPLE_TIER3_SCOPE_NODE)
      .step('work', spawnAgent)
      .step('record', recordCmd, ($e) => $e.inputFrom((item) => item))
      .exit('done');
    const spawnLane = P.lane('spawn-lane')
      .input(itemSchema)
      .key((item) => item.id)
      .runs(spawnFlow);
    const spawnHarness = P.harness('spawn-harness')
      .ledger(SAMPLE_LEDGER_NODE)
      .lanes(spawnLane);
    const spawnRuntime = createRuntime(spawnHarness, {
      registry: {
        ledgers: { 'sqlite:ledger': () => spawnLedger },
        scopes: { 'git:cow-worktree': () => spawnScope as never },
        models: { 'claude:model': () => spawnModelDriver },
      },
    });
    await spawnRuntime.start();
    await spawnRuntime.controller.enqueue(spawnLane, { id: 'spawn-parent' });
    expect(spawnExecuted).toEqual(['spawned-child', 'spawn-parent']);
    await spawnRuntime.stop();

    const conflictingRunnerStep = P.command('conflict-step')
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.boolean() }))
      .run(async (_in, ctx) => {
        ctx.getRunner(SAMPLE_RUNNER_NODE);
        ctx.getRunner({ ...SAMPLE_RUNNER_NODE, slots: 8 });
        return { ok: true };
      });

    await expect(
      runStep(
        conflictingRunnerStep,
        { id: 'c1' },
        {
          registry: {
            runners: {
              'node:runner': () => ({
                id: 'runner-1',
                withSlot: async (fn) => fn(),
                withDaemonSlot: async (fn) => fn(() => {}),
              }),
            },
          },
        },
      ),
    ).rejects.toThrow(
      "RunnerPoolASTNode 'local-runner' was already registered with (type='node:runner', slots=4, maxDaemons=2) but was requested again with conflicting configuration (type='node:runner', slots=8, maxDaemons=2) in runId 'standalone-run'.",
    );
  });
});


