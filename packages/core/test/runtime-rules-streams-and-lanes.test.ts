import { describe, expect, it } from 'vitest';
import {
  type AgentContinuationFrame, BudgetApprovalSchema, type ControlPlaneAdapter,
  DEFAULT_MAX_SEALED_AGE_HOURS, type FsGlobMatcherNode, type GitCommitAndPushNode,
  type GitWorktreeHandle, P, LaneScheduler, type LocalServiceNode, type LocalStreamCheckNode,
  type LoopContinuationFrame, type NodeHttpControlPlaneNode,
  ServiceSessionRegistry, type StepExecutionContext, type StreamSource, type ToolEffect,
  type TrackerAdapter, createExecutorRegistry, createRuntime, executeAgent, executeLoop, z,
} from '../src/index.js';
import {
  type ExtractStepInput, type ExtractStepOutput, type StepRunOptions, runStep,
} from '../src/runtime/index.js';
import { InMemoryLedgerStore } from './fixtures/in-memory-ledger-store.js';
import {
  SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE, SAMPLE_CLEAN_TREE_CHECK_NODE, SAMPLE_DECLARED_TOOL_NODE,
  SAMPLE_EXTRA_COMPARE_TOOL_NODE, SAMPLE_LEDGER_NODE, SAMPLE_MODEL_NODE, SAMPLE_NOTIFY_ONLY_HUMAN_CHANNEL_NODE,
  SAMPLE_RUNNER_NODE, SAMPLE_STREAM_SOURCE_NODE, SAMPLE_TIER3_SCOPE_NODE, SAMPLE_TRACKER_NODE,
} from './fixtures/sample-domain-nodes.constants.js';
import { ScriptedBranchableScope } from './fixtures/scripted-branchable-scope.js';
import { ScriptedHumanAdapter } from './fixtures/scripted-human-adapter.js';
import { ScriptedModelDriver } from './fixtures/scripted-model-driver.js';
import { ScriptedServiceSession } from './fixtures/scripted-service-session.js';
import { ScriptedToolDriver } from './fixtures/scripted-tool-driver.js';

type RuntimeStepContext = StepExecutionContext<GitWorktreeHandle> & { readonly _runtime: unknown };

const SAMPLE_HANDLE: GitWorktreeHandle = Object.freeze({
  worktreePath: '/tmp/wt', gitDirPath: '/tmp/wt/.git', branchName: 'b1', baseRef: 'HEAD', baseBranch: 'main', unresolvedConflictPaths: Object.freeze({}),
});
const WRITE_EFFECT_MATCHER: FsGlobMatcherNode = Object.freeze({
  type: 'fs:match-globs', id: 'match-db-writes', globs: Object.freeze(['db/**']), mode: 'any',
});
const SAMPLE_SERVICE_NODE: LocalServiceNode = Object.freeze({
  type: 'node:service', id: 'act-daemon', lifecycle: 'skill',
  toolSchemas: Object.freeze([SAMPLE_EXTRA_COMPARE_TOOL_NODE]),
  runner: SAMPLE_RUNNER_NODE, ports: Object.freeze([]), startArgv: () => Object.freeze(['node', 'daemon.js']), interactions: Object.freeze([]),
});

function throwUnusedRunner(): never {
  throw new Error('unused');
}

function makeTurn(visibleText: string, toolCalls: ReadonlyArray<{ id: string; name: string; argsJson: string }> = [], structuredOutput?: unknown, costUsd = 0.05) {
  return Object.freeze({
    wireFrame: new Uint8Array(), canonical: Object.freeze({ role: 'assistant' as const, visibleText, toolCalls: Object.freeze([...toolCalls]) }),
    structuredOutput, usage: Object.freeze({ inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, costUsd }),
  });
}

describe('M2 Runtime — P.rules & P.scopedRule (when.partitions, reactive when.effects, enforceBeforeStopChecks)', () => {
  it('injects when.partitions at Turn 0, deduplicates reactive when.effects in completedResults across suspension, and runs enforceBeforeStopChecks iff rule is injected and mutatesScope is true', async () => {
    expect(DEFAULT_MAX_SEALED_AGE_HOURS).toBe(168);
    const partRule = P.scopedRule('rule-part-db').when({ partitions: ['db'] }).directive('Partition DB rule directive.').enforceBeforeStop(SAMPLE_CLEAN_TREE_CHECK_NODE);
    const effectRule = P.scopedRule('rule-eff-write').when({ effects: WRITE_EFFECT_MATCHER }).directive('Reactive write rule directive.');
    const rulesNode = P.rules('repo-rules').global({ id: 'g1', directive: 'Global rule.' }).scoped(partRule, effectRule);

    const taskSchema = z.object({ id: z.string(), title: z.string() });
    const agent = P.agent<GitWorktreeHandle>('ruled-agent')
      .model(SAMPLE_MODEL_NODE).rules(rulesNode).tools(SAMPLE_DECLARED_TOOL_NODE).input(taskSchema).output(z.object({ done: z.boolean() }))
      .capabilities(($c) => $c.mutatePlan(($m) => $m.canSpawnTasks(taskSchema, { maxSpawnedPerRun: 2 })))
      .toAST();

    const ledgerStore = new InMemoryLedgerStore();
    await ledgerStore.createOrResumeRun({ runId: 'r-rules', laneId: 'l1', itemKey: 'k1', inputJson: '{}' });
    await ledgerStore.recordStepStart({ runId: 'r-rules', stepExecId: 's-susp', stepId: 'step-1', inputMsgId: null, continuationStack: [] });

    const modelSusp = new ScriptedModelDriver([
      makeTurn('call read then spawn', [
        { id: 'c1', name: 'fs_read', argsJson: JSON.stringify({ path: 'db/schema.sql' }) },
        { id: 'c2', name: 'spawnTasks', argsJson: JSON.stringify({ tasks: [{ item: { id: 'sub-1', title: 'Sub' } }] }) },
      ]),
    ]);
    let mutatesFlag = false;
    const toolDriver = new ScriptedToolDriver<GitWorktreeHandle>({
      describeEffects: (_node, args) => [Object.freeze<ToolEffect>({ kind: 'fs:read', mutatesScope: mutatesFlag, attributes: { path: (args as { readonly path: string }).path } })],
      handler: () => ({ content: 'read-ok', isError: false }),
    });
    let cleanCheckCalls = 0;
    const registry = createExecutorRegistry({
      models: { 'claude:model': () => modelSusp },
      tools: { 'fs:read': toolDriver },
      effectMatchers: { 'fs:match-globs': (_m, eff) => String(eff.attributes?.['path'] ?? '').startsWith('db/') },
      checks: {
        'git:clean-working-tree': async () => {
          cleanCheckCalls += 1;
          return { ok: true, deficits: [] };
        },
      },
    });

    const ctxSusp: RuntimeStepContext = Object.freeze({
      runId: 'r-rules', stepExecId: 's-susp', scopeHandle: SAMPLE_HANDLE, activePartitions: ['db'],
      activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: throwUnusedRunner,
      recordEffects: () => undefined, _runtime: { ledgerStore },
    });

    await expect(executeAgent(agent, { id: 'k1', title: 'Test' }, ctxSusp)).rejects.toThrow(/suspended on prerequisites/);

    const turn0Frame = ledgerStore.frames.get('msg:s-susp:turn-0');
    expect(turn0Frame?.canonical.visibleText).toContain('Partition DB rule directive.');
    const suspAgentFrame = ledgerStore.steps.get('s-susp')?.continuationStack[0] as AgentContinuationFrame | undefined;
    expect(suspAgentFrame?.injectedScopedRuleIds).toEqual(['rule-part-db', 'rule-eff-write']);
    if (suspAgentFrame?.pauseState.kind !== 'prerequisite-wait') {
      throw new Error('Expected prerequisite-wait pauseState');
    }
    expect(suspAgentFrame.pauseState.pendingToolBatch.completedResults).toEqual([
      { callId: 'c1', content: 'read-ok\n[SCOPED_RULE: rule-eff-write]\nReactive write rule directive.', isError: false },
    ]);

    const modelReadOnly = new ScriptedModelDriver([
      makeTurn('two reads', [
        { id: 'r1', name: 'fs_read', argsJson: JSON.stringify({ path: 'db/a.sql' }) },
        { id: 'r2', name: 'fs_read', argsJson: JSON.stringify({ path: 'db/b.sql' }) },
      ]),
      makeTurn(JSON.stringify({ done: true }), [], { done: true }),
    ]);
    const ctxReadOnly: RuntimeStepContext = Object.freeze({
      ...ctxSusp, stepExecId: 's-readonly',
      registry: createExecutorRegistry(registry, { models: { 'claude:model': () => modelReadOnly } }), _runtime: { ledgerStore },
    });

    const outReadOnly = await executeAgent(agent, { id: 'k2', title: 'Readonly' }, ctxReadOnly);
    expect(outReadOnly).toEqual({ done: true });
    expect(cleanCheckCalls).toBe(0);
    const toolFrameReadOnly = ledgerStore.frames.get('msg:s-readonly:tools:1');
    expect(toolFrameReadOnly?.canonical.toolResults?.[0]?.content).toContain('[SCOPED_RULE: rule-eff-write]');
    expect(toolFrameReadOnly?.canonical.toolResults?.[1]?.content).toBe('read-ok');

    mutatesFlag = true;
    const modelMutating = new ScriptedModelDriver([
      makeTurn('mutating call', [{ id: 'm1', name: 'fs_read', argsJson: JSON.stringify({ path: 'db/mut.sql' }) }]),
      makeTurn(JSON.stringify({ done: true }), [], { done: true }),
    ]);
    const ctxMutating: RuntimeStepContext = Object.freeze({
      ...ctxSusp, stepExecId: 's-mutating',
      registry: createExecutorRegistry(registry, { models: { 'claude:model': () => modelMutating } }), _runtime: { ledgerStore },
    });

    await executeAgent(agent, { id: 'k3', title: 'Mutating' }, ctxMutating);
    expect(cleanCheckCalls).toBe(1);
  });
});

describe('M2 Runtime — P.stream, P.harness (.onSignal().notify, .expose) & P.lane.tracker stateMappings', () => {
  it('subscribes StreamSource with filterFn/mapPayload -> emitSignal -> .notify(), starts/closes ControlPlaneAdapter, and syncs TrackerAdapter across canonical stateMappings', async () => {
    const ledgerStore = new InMemoryLedgerStore();
    const humanAdapter = new ScriptedHumanAdapter();
    const notifyHuman = P.human('ops-pager').notify<'bidirectional' | 'notify-only'>(SAMPLE_NOTIFY_ONLY_HUMAN_CHANNEL_NODE);
    const budgetHuman = P.human('budget-owner').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE).withName('approver').output(BudgetApprovalSchema);
    const webhookSig = P.signal('sig-webhook', z.object({ pr: z.number() }));
    const stream = P.stream('pr-stream')
      .source<unknown>(SAMPLE_STREAM_SOURCE_NODE)
      .filter((ev: unknown) => (ev as { readonly merged: boolean }).merged)
      .emitSignal(webhookSig, (ev: unknown) => ({ pr: (ev as { readonly prNumber: number }).prNumber }));

    const controlPlaneNode: NodeHttpControlPlaneNode = Object.freeze({ type: 'node:http-control-plane', id: 'http-cp', port: 0 });
    let streamClosed = false;
    let cpClosed = false;
    let pushedEventHandler: ((raw: { readonly prNumber: number; readonly merged: boolean }) => Promise<void>) | undefined;

    const streamSourceDriver: StreamSource<{ readonly prNumber: number; readonly merged: boolean }> = {
      async subscribe(onEvent) {
        pushedEventHandler = onEvent;
        return { async close() {
          streamClosed = true;
        } };
      },
    };
    const cpAdapter: ControlPlaneAdapter = {
      async start(controller) {
        await controller.getActiveRuns();
        return { async close() {
          cpClosed = true;
        } };
      },
    };

    const itemSchema = z.object({ id: z.string(), title: z.string(), deps: z.array(z.string()).default([]), shouldFail: z.boolean().optional(), shouldSuspend: z.boolean().optional() });
    let capturedRunnerError = '';
    const stepCmd = P.command('tracker-step', {
      input: itemSchema, output: z.object({ ok: z.boolean() }),
      fn: async (input: z.output<typeof itemSchema>, ctx) => {
        try {
          ctx.getRunner(SAMPLE_RUNNER_NODE);
        } catch (e) {
          capturedRunnerError = (e as Error).message;
        }
        if (input.shouldFail === true) throw new Error('Step failed');
        if (input.shouldSuspend === true) {
          const err = new Error('Suspended') as Error & { code?: string };
          err.code = 'HARNESS_STEP_SUSPENDED';
          throw err;
        }
        return { ok: true };
      },
    });
    const flow = P.flow('tracker-flow').input(itemSchema).scope(SAMPLE_TIER3_SCOPE_NODE).step('s1', stepCmd).exit('pr-opened');
    const lane = P.lane('tracker-lane')
      .input(itemSchema).key((i: z.output<typeof itemSchema>) => i.id)
      .tracker(SAMPLE_TRACKER_NODE, ($t) =>
        $t.everySeconds(10)
          .from((raw: { readonly id: string; readonly title: string; readonly ready: boolean }) => (raw.ready ? { id: raw.id, title: raw.title, deps: [] } : undefined))
          .onQueued('queued').onRunning('in-progress').onWaiting('needs-human').onErrored('errored').onCancelled('cancelled')
          .onExit('pr-opened', 'pr-open').onExit('abandoned', 'abandoned'),
      )
      .waitFor((i: z.output<typeof itemSchema>) => i.deps, 'abandoned')
      .concurrency(3).maxCostUsd(1.0, budgetHuman).retry(($r) => $r.tries(1).exponential(0).orFail('abandoned')).runs(flow);

    const externalTransitions: Array<{ readonly itemKey: string; readonly state: string }> = [];
    const trackerAdapter: TrackerAdapter<{ readonly id: string; readonly title: string; readonly ready: boolean }, string> = {
      async poll() { return [{ id: 'iss-skip', title: 'Draft', ready: false }, { id: 'iss-1', title: 'Ready Issue', ready: true }]; },
      async setExternalState(itemKey, state) { externalTransitions.push({ itemKey, state }); },
    };

    const scope = new ScriptedBranchableScope();
    const registry = createExecutorRegistry({
      ledgers: { 'sqlite:ledger': () => ledgerStore }, scopes: { 'git:cow-worktree': () => scope as never },
      streamSources: { 'github:webhook-stream': () => streamSourceDriver }, controlPlanes: { 'node:http-control-plane': () => cpAdapter },
      trackers: { 'github:issues': () => trackerAdapter as never },
    });

    const harness = P.harness('stream-harness')
      .ledger(SAMPLE_LEDGER_NODE).streams(stream.toAST()).lanes(lane)
      .onSignal(webhookSig, ($s) => $s.notify(notifyHuman.toAST(), (p: { readonly pr: number }) => `PR #${String(p.pr)} merged`)).expose(controlPlaneNode);

    const runtime = createRuntime(harness, { registry, humanAdaptersById: new Map([['ops-pager', humanAdapter], ['budget-owner', humanAdapter]]) });
    await runtime.start();
    await pushedEventHandler?.({ prNumber: 10, merged: false });
    expect(humanAdapter.notifications).toHaveLength(0);
    await pushedEventHandler?.({ prNumber: 42, merged: true });
    expect(humanAdapter.notifications).toEqual(['PR #42 merged']);
    await runtime.stop();
    expect([streamClosed, cpClosed]).toEqual([true, true]);

    streamClosed = false;
    const failCpRegistry = createExecutorRegistry(registry, { controlPlanes: { 'node:http-control-plane': () => ({ start: () => Promise.reject(new Error('cp start failed')) }) } });
    const failingRuntime = createRuntime(harness, {
      registry: failCpRegistry,
      humanAdaptersById: new Map([
        ['ops-pager', humanAdapter],
        ['budget-owner', humanAdapter],
      ]),
    });
    await expect(failingRuntime.start()).rejects.toThrow('cp start failed');
    expect(streamClosed).toBe(true);

    const scheduler = new LaneScheduler({ lane: lane.toAST(), registry, env: {}, ledgerStore, humanAdaptersById: new Map([['budget-owner', humanAdapter]]) });
    expect((await scheduler.pollTrackerOnce()).map((p) => p.itemKey)).toEqual(['iss-1']);
    await scheduler.enqueueItem({ input: { id: 'iss-wait', title: 'Waiter', deps: ['iss-fail'] } });
    await scheduler.enqueueItem({ input: { id: 'iss-fail', title: 'Failing', deps: [], shouldFail: true } });
    await scheduler.scheduleNextReadyRuns();
    expect(capturedRunnerError).toMatch(/No RunnerDriver registered for 'node:runner' \(runner id 'local-runner', lane 'tracker-lane'\)\./);
    await scheduler.enqueueItem({ input: { id: 'iss-susp', title: 'Suspending', deps: [], shouldSuspend: true } });
    await scheduler.scheduleNextReadyRuns();
    humanAdapter.enqueueDecision({ approved: false });
    await scheduler.enforceRunBudget('run:tracker-lane:iss-susp', 5.0);

    expect(externalTransitions).toEqual([
      { itemKey: 'iss-1', state: 'queued' }, { itemKey: 'iss-wait', state: 'needs-human' }, { itemKey: 'iss-fail', state: 'queued' },
      { itemKey: 'iss-1', state: 'in-progress' }, { itemKey: 'iss-1', state: 'pr-open' }, { itemKey: 'iss-fail', state: 'in-progress' },
      { itemKey: 'iss-fail', state: 'errored' }, { itemKey: 'iss-fail', state: 'abandoned' }, { itemKey: 'iss-susp', state: 'queued' },
      { itemKey: 'iss-wait', state: 'abandoned' }, { itemKey: 'iss-susp', state: 'in-progress' }, { itemKey: 'iss-susp', state: 'needs-human' },
      { itemKey: 'iss-susp', state: 'cancelled' },
    ]);
  });
});

describe('M2 Runtime — Mixed-Turn Tool Batching & P.loop Step-Boundary Isolation', () => {
  it('drains (1..m) regular tools, contiguous capability .fork() (m+1..p) with precedingCompletedResults & siblingForkCallIds, and trailing (p+1..k) tools into a single role: tool wire frame', async () => {
    const childWorker = P.agent<GitWorktreeHandle>('mixed-child').model(SAMPLE_MODEL_NODE).input(z.object({ task: z.string() })).output(z.object({ childResult: z.string() }));
    const parentAgent = P.agent<GitWorktreeHandle>('mixed-parent')
      .model(SAMPLE_MODEL_NODE).tools(SAMPLE_DECLARED_TOOL_NODE, SAMPLE_EXTRA_COMPARE_TOOL_NODE)
      .input(z.object({ goal: z.string() })).output(z.object({ summary: z.string() }))
      .capabilities(($c) =>
        $c.fork('runSubtask', childWorker, ($f) =>
          $f.requestSchema(z.object({ task: z.string() })).mapInput((_p: { readonly goal: string }, r: { readonly task: string }) => r).historyMode('clone-transcript'),
        ),
      )
      .toAST();

    const ledgerStore = new InMemoryLedgerStore();
    await ledgerStore.createOrResumeRun({ runId: 'r-mixed', laneId: 'l1', itemKey: 'k-mixed', inputJson: '{}' });
    await ledgerStore.recordStepStart({ runId: 'r-mixed', stepExecId: 's-mixed', stepId: 'step-1', inputMsgId: null, continuationStack: [] });

    const scope = new ScriptedBranchableScope();
    await scope.acquireRoot('r-mixed');
    const executionOrder: string[] = [];
    const modelDriver = new ScriptedModelDriver([
      makeTurn('mixed batch turn', [
        { id: 'call-1-pre', name: 'fs_read', argsJson: JSON.stringify({ path: 'a.txt' }) },
        { id: 'call-2a-fork', name: 'runSubtask', argsJson: JSON.stringify({ forkId: 'f-mid-1', task: 'middle-1' }) },
        { id: 'call-2b-fork', name: 'runSubtask', argsJson: JSON.stringify({ forkId: 'f-mid-2', task: 'middle-2' }) },
        { id: 'call-3-post', name: 'git_compare', argsJson: JSON.stringify({ left: 'main', right: 'HEAD' }) },
      ]),
      makeTurn(JSON.stringify({ summary: 'all-four-done' }), [], { summary: 'all-four-done' }),
    ]);

    const toolDriver = new ScriptedToolDriver<GitWorktreeHandle>({
      handler: (node) => {
        executionOrder.push(`tool:${node.name}`);
        return { content: `out:${node.name}`, isError: false };
      },
    });
    const registry = createExecutorRegistry({
      models: { 'claude:model': () => modelDriver },
      tools: { 'fs:read': toolDriver },
      scopes: { 'git:cow-worktree': () => scope as never },
    });

    const ctx: RuntimeStepContext = Object.freeze({
      runId: 'r-mixed', stepExecId: 's-mixed', scopeHandle: SAMPLE_HANDLE,
      scopeNode: SAMPLE_TIER3_SCOPE_NODE, activePartitions: [], activeLeases: [], observedEffects: [],
      registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined,
      _runtime: {
        ledgerStore,
        executeChildStep: async () => {
          executionOrder.push('fork:runSubtask');
          return { status: 'completed' as const, output: { childResult: 'fork-ok' }, continuationStack: [] };
        },
      },
    });

    const out = await executeAgent(parentAgent, { goal: 'ship' }, ctx);
    expect(out).toEqual({ summary: 'all-four-done' });
    expect(executionOrder).toEqual(['tool:fs_read', 'fork:runSubtask', 'fork:runSubtask', 'tool:git_compare']);
    expect(modelDriver.recordedForks[0]?.ctx.precedingCompletedResults).toEqual([
      { callId: 'call-1-pre', content: 'out:fs_read', isError: false },
    ]);
    expect(modelDriver.recordedForks[0]?.ctx.siblingForkCallIds).toEqual(['call-2a-fork', 'call-2b-fork']);

    const toolFrame = ledgerStore.frames.get('msg:s-mixed:tools:1');
    expect(toolFrame?.canonical.role).toBe('tool');
    expect(toolFrame?.canonical.toolResults?.map((r) => r.callId)).toEqual(['call-1-pre', 'call-2a-fork', 'call-2b-fork', 'call-3-post']);
  });

  it('registers static Turn-0 skill/service tools, dispatches unlocked service tools, quiesces daemons on .act() -> .evaluate(), and counts quantitative tripwires strictly on .act() turns', async () => {
    const actSkill = P.skill('act-skill').description('Act daemon skill').instructions('Use daemon').unlocksServices(SAMPLE_SERVICE_NODE);
    const evalSkill = P.skill('eval-skill').description('Evaluator skill').instructions('Eval only').unlocksTools(SAMPLE_DECLARED_TOOL_NODE);
    const strictActPolicy = P.policy<GitWorktreeHandle>('act-policy').maxTurns(3);

    const actAgent = P.agent<GitWorktreeHandle>('loop-worker').model(SAMPLE_MODEL_NODE).policy(strictActPolicy).skills(actSkill).input(z.object({ id: z.string() })).output(z.object({ code: z.string() }));
    const evalAgent = P.agent<GitWorktreeHandle>('loop-evaluator').model(SAMPLE_MODEL_NODE).skills(evalSkill).input(z.object({ code: z.string() })).output(z.object({ passed: z.boolean() }));

    const loopNode = P.loop<GitWorktreeHandle>('isolated-loop')
      .input(z.object({ id: z.string() })).output(z.object({ code: z.string() })).maxIterations(2).preserveActorSession(true)
      .act('act-step', actAgent)
      .evaluate('eval-step', evalAgent, {
        mapInput: (_in, actOut: { readonly code: string }) => ({ code: actOut.code }),
        acceptWhen: (v: { readonly passed: boolean }) => v.passed,
        feedbackMapper: () => 'retry',
      })
      .returnOutputFrom('act-step')
      .toAST();

    const daemonSession = new ScriptedServiceSession('act-daemon', [SAMPLE_EXTRA_COMPARE_TOOL_NODE as never]);
    let daemonRunningAtEvalStart: boolean | undefined;
    const modelDriver = new ScriptedModelDriver([
      makeTurn('activate act skill and invoke service tool', [
        { id: 'a1', name: 'activateSkill', argsJson: JSON.stringify({ skillId: 'act-skill' }) },
        { id: 'a2', name: 'git_compare', argsJson: JSON.stringify({ left: 'main', right: 'HEAD' }) },
      ], undefined, 0.1),
      makeTurn(JSON.stringify({ code: 'v1' }), [], { code: 'v1' }, 0.1),
      makeTurn('activate eval skill', [{ id: 'e1', name: 'activateSkill', argsJson: JSON.stringify({ skillId: 'eval-skill' }) }], undefined, 0.2),
      makeTurn('use eval tool', [{ id: 'e2', name: 'fs_read', argsJson: JSON.stringify({ path: 'check.ts' }) }], undefined, 0.2),
      makeTurn(JSON.stringify({ passed: true }), [], { passed: true }, 0.2),
    ]);

    const toolDriver = new ScriptedToolDriver<GitWorktreeHandle>({
      handler: () => {
        daemonRunningAtEvalStart = daemonSession.running;
        return { content: 'checked', isError: false };
      },
    });
    const serviceRegistry = new ServiceSessionRegistry();
    const ledgerStore = new InMemoryLedgerStore();
    await ledgerStore.createOrResumeRun({ runId: 'r-loop', laneId: 'l1', itemKey: 'k-loop', inputJson: '{}' });
    await ledgerStore.recordStepStart({ runId: 'r-loop', stepExecId: 's-loop', stepId: 'step-1', inputMsgId: null, continuationStack: [] });

    const registry = createExecutorRegistry({
      models: { 'claude:model': () => modelDriver },
      tools: { 'fs:read': toolDriver },
      services: { 'node:service': async () => daemonSession as never },
    });

    const ctx: RuntimeStepContext = Object.freeze({
      runId: 'r-loop', stepExecId: 's-loop', scopeHandle: SAMPLE_HANDLE, activePartitions: [], activeLeases: [], observedEffects: [],
      registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined,
      _runtime: { ledgerStore, serviceRegistry },
    });

    const result = await executeLoop(loopNode, { id: 'item-1' }, ctx);
    expect(result).toEqual({ code: 'v1' });
    expect(modelDriver.recordedRequests[0]?.wireToolSchemas?.map((t) => t.name)).toEqual(['activateSkill', 'completeSkill', 'git_compare']);
    expect(modelDriver.recordedRequests[0]?.wireToolSchemas?.find((t) => t.name === 'git_compare')?.description).toContain('[Requires active skill: act-skill]');
    expect(daemonSession.toolCalls).toEqual([{ toolName: 'git_compare', args: { left: 'main', right: 'HEAD' } }]);
    expect(daemonRunningAtEvalStart).toBe(false);
    expect(daemonSession.stopCount).toBe(1);

    const savedLoopFrame = ledgerStore.steps.get('s-loop')?.continuationStack.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame');
    expect(savedLoopFrame?.activeSkillIds).toEqual(['act-skill']);
    expect(savedLoopFrame?.actTurnsTaken).toBe(2);
    expect(savedLoopFrame?.turnsTaken).toBe(5);
    expect(savedLoopFrame?.actCostUsd).toBeCloseTo(0.2, 5);
    expect(savedLoopFrame?.costUsd).toBeCloseTo(0.8, 5);
  });
});

describe('M2 Runtime — runStep standalone step runner (P1)', () => {
  it('executes builder and AST step nodes, derives activePartitions via extractPartitions, memoizes getRunner, and throws fail-closed on missing runner driver', async () => {
    const partRule = P.scopedRule('rule-part-auth').when({ partitions: ['auth'] }).directive('Auth partition directive.');
    const rulesNode = P.rules('step-rules').scoped(partRule);
    const agentBuilder = P.agent<GitWorktreeHandle>('standalone-agent')
      .model(SAMPLE_MODEL_NODE)
      .rules(rulesNode)
      .input(z.object({ targetPartition: z.string() }))
      .output(z.object({ ok: z.boolean() }))
      .partitions((i) => [i.targetPartition]);

    const modelDriver = new ScriptedModelDriver([
      makeTurn(JSON.stringify({ ok: true }), [], { ok: true }),
    ]);

    const options: StepRunOptions<GitWorktreeHandle> = {
      scopeHandle: SAMPLE_HANDLE,
      registry: [{ models: { 'claude:model': () => modelDriver } }],
    };

    const agentOut = await runStep(agentBuilder, { targetPartition: 'auth' }, options);
    expect(agentOut).toEqual({ ok: true });
    expect(modelDriver.recordedRequests[0]?.history[0]?.canonical.visibleText).toContain('Auth partition directive.');

    let runnerFactoryCalls = 0;
    const fakeRunner = Object.freeze({
      acquireSlot: async () => ({ release: () => undefined }),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    });
    const cmdStep = P.command<GitWorktreeHandle>('inspect-ctx')
      .input(z.object({ key: z.string() }))
      .output(z.object({
        runId: z.string(),
        stepExecId: z.string(),
        resolvedSecret: z.string().optional(),
        sameRunner: z.boolean(),
        effectCount: z.number(),
      }))
      .run(async (input, ctx) => {
        const r1 = ctx.getRunner(SAMPLE_RUNNER_NODE);
        const r2 = ctx.getRunner(SAMPLE_RUNNER_NODE);
        ctx.recordEffects([Object.freeze<ToolEffect>({ kind: 'fs:write', mutatesScope: true })]);
        return {
          runId: ctx.runId,
          stepExecId: ctx.stepExecId,
          resolvedSecret: ctx.resolveEnv(P.env(input.key)),
          sameRunner: r1 === r2,
          effectCount: ctx.observedEffects.length,
        };
      });

    const cmdOut = await runStep(cmdStep, { key: 'API_TOKEN' }, {
      scopeHandle: SAMPLE_HANDLE,
      registry: {
        runners: {
          'node:runner': () => {
            runnerFactoryCalls += 1;
            return fakeRunner as never;
          },
        },
      },
      env: { API_TOKEN: 'secret-val' },
    });
    expect(cmdOut).toEqual({
      runId: 'standalone-run',
      stepExecId: 'standalone-step-1',
      resolvedSecret: 'secret-val',
      sameRunner: true,
      effectCount: 1,
    });
    expect(runnerFactoryCalls).toBe(1);

    const missingRunnerStep = P.command<GitWorktreeHandle>('missing-runner-step')
      .input(z.object({}))
      .output(z.object({}))
      .run(async (_in, ctx) => {
        ctx.getRunner(SAMPLE_RUNNER_NODE);
        return {};
      });

    await expect(
      runStep(missingRunnerStep, {}, { scopeHandle: SAMPLE_HANDLE, registry: {} }),
    ).rejects.toThrow("No RunnerDriver registered for 'node:runner' (runner id 'local-runner', runId 'standalone-run').");

    const ledgerStore = new InMemoryLedgerStore();
    const webhookSig = P.signal('p16-webhook', z.object({ pr: z.number() }));
    const stream = P.stream('p16-stream')
      .source<unknown>(SAMPLE_STREAM_SOURCE_NODE)
      .emitSignal(webhookSig, () => ({ pr: 1 }));
    const cpNode: NodeHttpControlPlaneNode = Object.freeze({
      type: 'node:http-control-plane',
      id: 'cp-1',
      port: 0,
    });
    const flow = P.flow('p16-flow')
      .input(z.object({ id: z.string() }))
      .scope(SAMPLE_TIER3_SCOPE_NODE)
      .exit('done');
    const trackerLane = P.lane('p16-tracker-lane')
      .input(z.object({ id: z.string() }))
      .key((i) => i.id)
      .tracker(SAMPLE_TRACKER_NODE, ($t) =>
        $t
          .everySeconds(10)
          .from((raw: { readonly id: string }) => raw)
          .onQueued('queued')
          .onRunning('in-progress')
          .onWaiting('needs-human')
          .onErrored('errored')
          .onCancelled('cancelled')
          .onExit('done', 'pr-open'),
      )
      .runs(flow);

    expect(() =>
      createRuntime(
        P.harness('p16-missing-stream').ledger(SAMPLE_LEDGER_NODE).streams(stream),
        { registry: { ledgers: { 'sqlite:ledger': () => ledgerStore } } },
      ),
    ).toThrow(
      "No StreamSource registered for 'github:webhook-stream' on stream 'p16-stream' in harness 'p16-missing-stream' (registered streamSources: []).",
    );

    expect(() =>
      createRuntime(
        P.harness('p16-missing-cp').ledger(SAMPLE_LEDGER_NODE).expose(cpNode),
        { registry: { ledgers: { 'sqlite:ledger': () => ledgerStore } } },
      ),
    ).toThrow(
      "No ControlPlaneAdapter registered for 'node:http-control-plane' in harness 'p16-missing-cp' (registered controlPlanes: []).",
    );

    expect(() =>
      createRuntime(
        P.harness('p16-missing-tracker').ledger(SAMPLE_LEDGER_NODE).lanes(trackerLane),
        { registry: { ledgers: { 'sqlite:ledger': () => ledgerStore } } },
      ),
    ).toThrow(
      "No TrackerAdapter registered for 'github:issues' on lane 'p16-tracker-lane' (registered trackers: []).",
    );
  });

  it('infers ExtractStepInput and ExtractStepOutput across P.agent, P.loop, P.command, GitCommitAndPushNode, and LocalStreamCheckNode without explicit type arguments', async () => {
    const loopActAgent = P.agent<GitWorktreeHandle>('r2-p3-act')
      .model(SAMPLE_MODEL_NODE)
      .input(z.object({ ticket: z.string() }))
      .output(z.object({ summary: z.string() }));
    const loopEvalAgent = P.agent<GitWorktreeHandle>('r2-p3-eval')
      .model(SAMPLE_MODEL_NODE)
      .input(z.object({ summary: z.string() }))
      .output(z.object({ accepted: z.boolean() }));
    const loopBuilder = P.loop<GitWorktreeHandle>('r2-p3-loop')
      .act('execute', loopActAgent)
      .evaluate('verify', loopEvalAgent, {
        mapInput: (_in: { readonly ticket: string }, actOut: { readonly summary: string }) => ({ summary: actOut.summary }),
        acceptWhen: (v: { readonly accepted: boolean }) => v.accepted,
        feedbackMapper: () => 'retry',
      })
      .maxIterations(1);
    const commitNode: GitCommitAndPushNode<{ readonly branch: string }> = Object.freeze({
      type: 'git:commit-and-push',
      id: 'r2-p3-commit',
      inputSchema: z.object({ branch: z.string() }),
      outputSchema: z.void(),
      branch: (input: { readonly branch: string }) => input.branch,
      message: (input: { readonly branch: string }) => `feat: ${input.branch}`,
      runner: SAMPLE_RUNNER_NODE,
    });
    const streamCheckNode: LocalStreamCheckNode<GitWorktreeHandle> = Object.freeze({
      type: 'node:stream-check',
      id: 'r2-p3-stream-check',
      inputSchema: z.unknown(),
      outputSchema: z.object({ ok: z.boolean(), deficits: z.array(z.string()) }),
      runner: SAMPLE_RUNNER_NODE,
      argv: Object.freeze(['pnpm', 'test']),
    });

    const modelDriver = new ScriptedModelDriver([
      makeTurn(JSON.stringify({ summary: 'shipped' }), [], { summary: 'shipped' }),
      makeTurn(JSON.stringify({ accepted: true }), [], { accepted: true }),
    ]);
    const options: StepRunOptions<GitWorktreeHandle> = {
      scopeHandle: SAMPLE_HANDLE,
      registry: {
        models: { 'claude:model': () => modelDriver },
        checks: {
          'git:clean-working-tree': async () => ({ ok: true, deficits: [] }),
        },
        steps: {
          'git:commit-and-push': async () => undefined,
          'node:stream-check': async () => ({ ok: true, deficits: ['none'] }),
        },
      },
    };

    const loopInput: ExtractStepInput<ReturnType<typeof loopBuilder.toAST>> = { ticket: 'T-42' };
    const loopOut = await runStep(loopBuilder, loopInput, options);
    expect(loopOut.summary).toBe('shipped');

    const commitInput: ExtractStepInput<typeof commitNode> = { branch: 'feat/r2-p3' };
    const commitOut = await runStep(commitNode, commitInput, options);
    const voidCheck: void = commitOut;
    expect(voidCheck).toBeUndefined();

    const streamOut = await runStep(
      streamCheckNode,
      undefined,
      options,
    );
    expect(streamOut.ok).toBe(true);
    expect(streamOut.deficits).toEqual(['none']);
  });
});


