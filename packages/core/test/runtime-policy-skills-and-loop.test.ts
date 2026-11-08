import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentContinuationFrame, type ClaudeModelNode, type FsGlobMatcherNode, type FsProtectGuardNode,
  type FsQuotaTripwireNode, type GitScopeReceipt, type GitWorktreeHandle, M, type InlineSkillNode,
  type LeaseDelta, type LocalServiceNode, type ModelASTNode, type PolicyLimitExceededBuilder,
  type PolicyViolation, PoolManager, type PoolStrategyConfigurator, ScopeLockManager,
  ServiceSessionRegistry, type StepExecutionContext, type ToolEffect, createExecutorRegistry,
  evaluatePreFlightToolBatch, executeAgent, executeLimitExceededSequence, executeLoop, executePostFlightSandboxedTool,
} from '../src/index.js';
import { InMemoryLedgerStore } from './fixtures/in-memory-ledger-store.js';
import { InMemoryLessonStore } from './fixtures/in-memory-lesson-store.js';
import { InMemoryTopologyStore } from './fixtures/in-memory-topology-store.js';
import {
  SAMPLE_ABORT_HOOK_NODE, SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE, SAMPLE_CLEAN_TREE_CHECK_NODE,
  SAMPLE_DECLARED_TOOL_NODE, SAMPLE_EXTRA_COMPARE_TOOL_NODE, SAMPLE_MODEL_NODE,
  SAMPLE_POST_FLIGHT_SUBPROCESS_TOOL_NODE, SAMPLE_RUNNER_NODE, SAMPLE_TIER3_SCOPE_NODE,
} from './fixtures/sample-domain-nodes.constants.js';
import { ScriptedBranchableScope } from './fixtures/scripted-branchable-scope.js';
import { ScriptedHumanAdapter } from './fixtures/scripted-human-adapter.js';
import { ScriptedModelDriver } from './fixtures/scripted-model-driver.js';
import { ScriptedServiceSession } from './fixtures/scripted-service-session.js';
import { ScriptedToolDriver } from './fixtures/scripted-tool-driver.js';

const SAMPLE_HANDLE: GitWorktreeHandle = Object.freeze({ worktreePath: '/tmp/wt', gitDirPath: '/tmp/wt/.git', branchName: 'b1', baseRef: 'HEAD', baseBranch: 'main', unresolvedConflictPaths: Object.freeze({}) });
const GLOB_MATCHER_NODE: FsGlobMatcherNode = Object.freeze({ type: 'fs:match-globs', id: 'match-secrets', globs: Object.freeze(['secrets/**']), mode: 'any' });
const WRITE_GUARD_NODE: FsProtectGuardNode = Object.freeze({ type: 'fs:protect', id: 'guard-secrets', globs: Object.freeze(['secrets/**']) });
const HARD_DENY_GUARD_NODE: FsProtectGuardNode = Object.freeze({ type: 'fs:protect', id: 'guard-env', globs: Object.freeze(['.env']) });
const MAX_FILES_TRIPWIRE_NODE: FsQuotaTripwireNode = Object.freeze({ type: 'fs:quota-tripwire', id: 'trip-max-files', maxFilesMutated: 1 });
const SAMPLE_SERVICE_NODE: LocalServiceNode = Object.freeze({ type: 'node:service', id: 'dev-server', lifecycle: 'skill', toolSchemas: Object.freeze([]), runner: SAMPLE_RUNNER_NODE, ports: Object.freeze([]), startArgv: () => Object.freeze(['node', 'server.js']), interactions: Object.freeze([]) });

function makeTurn(visibleText: string, toolCalls: ReadonlyArray<{ id: string; name: string; argsJson: string }> = [], structuredOutput?: unknown) {
  return Object.freeze({ wireFrame: new Uint8Array(), canonical: Object.freeze({ role: 'assistant' as const, visibleText, toolCalls: Object.freeze([...toolCalls]) }), structuredOutput, usage: Object.freeze({ inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.01 }) });
}
function throwUnusedRunner(): never {
  throw new Error('unused');
}

describe('Two-phase policy guard evaluation, multi-call batching, and nested adjudication', () => {
  it('enforces deny-with-error before raise-interrupt and batches trailing calls failing the same raise-interrupt clause C', async () => {
    const intr = M.interrupt('sec-intr', z.object({ summary: z.string(), count: z.number() }));
    const policy = M.policy<GitWorktreeHandle>('two-phase-policy')
      .guard(WRITE_GUARD_NODE).onViolation('raise-interrupt', intr, (v: PolicyViolation) => ({ summary: v.violationSummary, count: v.blockedCalls.length }))
      .guard(HARD_DENY_GUARD_NODE).onViolation('deny-with-error', (v: PolicyViolation) => `Hard denied: ${v.violationSummary}`).toAST();

    const toolDriver = new ScriptedToolDriver<GitWorktreeHandle>({
      describeEffects: (_node, args) => [Object.freeze<ToolEffect>({ kind: 'fs:read', mutatesScope: false, attributes: { path: (args as { readonly path: string }).path } })],
    });
    const registry = createExecutorRegistry({
      tools: { 'fs:read': toolDriver },
      policyGuards: {
        'fs:protect': (guard, input) => {
          const hit = input.proposedEffects.filter((eff) => guard.globs.some((g) => String(eff.attributes?.['path'] ?? '').startsWith(g.replace('/**', ''))));
          return { allowed: hit.length === 0, violatedEffects: hit, violationSummary: `Blocked ${guard.id}` };
        },
      },
      effectMatchers: { 'fs:match-globs': () => true },
    });
    const ctx: StepExecutionContext<GitWorktreeHandle> = { runId: 'r1', stepExecId: 's1', scopeHandle: SAMPLE_HANDLE, activePartitions: [], activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined };
    const toolsByName = new Map([[SAMPLE_DECLARED_TOOL_NODE.name, SAMPLE_DECLARED_TOOL_NODE]]);

    const denyFirst = await evaluatePreFlightToolBatch({ policy, remainingCalls: [{ callId: 'c0', toolName: 'fs_read', argsJson: JSON.stringify({ path: '.env' }) }], toolsByName, activeLeases: [], ctx });
    expect([denyFirst.status, denyFirst.deniedErrorMessage]).toEqual(['denied-with-error', 'Hard denied: Blocked guard-env']);

    const batched = await evaluatePreFlightToolBatch({
      policy, toolsByName, activeLeases: [], ctx,
      remainingCalls: [{ callId: 'c1', toolName: 'fs_read', argsJson: JSON.stringify({ path: 'secrets/a.txt' }) }, { callId: 'c2', toolName: 'fs_read', argsJson: JSON.stringify({ path: 'secrets/b.txt' }) }, { callId: 'c3', toolName: 'fs_read', argsJson: JSON.stringify({ path: 'src/ok.ts' }) }],
    });
    expect([batched.status, batched.blockedCalls?.map((b) => b.callId), batched.interruptPayload]).toEqual(['raise-interrupt', ['c1', 'c2'], { summary: 'Blocked guard-secrets; Blocked guard-secrets', count: 2 }]);
  });

  it('replays remainingCalls in declaration order after nested .adjudicateWith() lease elevation, unlocks same-turn skill tools, and skips dependent calls on lease denial', async () => {
    const secIntr = M.interrupt('sec-intr', z.object({ summary: z.string() }));
    const humanEscIntr = M.interrupt('human-esc', z.object({ question: z.string() }));
    const human = M.human('sec-human').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE);
    const leaseDelta: LeaseDelta = Object.freeze({ type: 'harness:lease-delta', id: 'lease-secrets', grantedMatchers: Object.freeze([GLOB_MATCHER_NODE]) });
    const unlockSkill = M.skill<GitWorktreeHandle>('sec-skill').description('S').instructions('I').unlocksTools(SAMPLE_EXTRA_COMPARE_TOOL_NODE);
    const adjudicator = M.agent<GitWorktreeHandle>('adj-agent').model(SAMPLE_MODEL_NODE).input(z.object({ summary: z.string() })).output(z.object({ allow: z.boolean(), note: z.string() }));
    const policy = M.policy<GitWorktreeHandle>('batch-policy').guard(WRITE_GUARD_NODE).onViolation('raise-interrupt', secIntr, (v: PolicyViolation) => ({ summary: v.violationSummary })).toAST();
    const worker = M.agent<GitWorktreeHandle>('worker')
      .model(SAMPLE_MODEL_NODE).policy(policy).tools(SAMPLE_DECLARED_TOOL_NODE).skills(unlockSkill)
      .input(z.object({ task: z.string() })).output(z.object({ done: z.boolean() }))
      .onInterrupt(secIntr, ($i) =>
        $i.adjudicateWith(adjudicator, (_in: { readonly task: string }, p: { readonly summary: string }) => ({ summary: p.summary }))
          .onInterrupt(humanEscIntr, ($hi) => $hi.ask(human, z.object({ grant: z.boolean() })).elevateLeaseWhen((d: { readonly grant: boolean }) => d.grant, (): LeaseDelta => leaseDelta).resumeWith((d: { readonly grant: boolean }) => (d.grant ? 'Human granted' : 'Human denied')))
          .resumeWith((_in: { readonly task: string }, _p: { readonly summary: string }, out: { readonly allow: boolean; readonly note: string }) => out.note),
      ).toAST();

    const toolDriver = new ScriptedToolDriver<GitWorktreeHandle>({ describeEffects: (_node, args) => [Object.freeze<ToolEffect>({ kind: 'fs:read', mutatesScope: false, attributes: { path: String((args as { readonly path?: string }).path ?? 'compare') } })] });
    const modelDriver = new ScriptedModelDriver([
      makeTurn('', [{ id: 'c0', name: 'activateSkill', argsJson: JSON.stringify({ skillId: 'sec-skill' }) }, { id: 'c0b', name: 'git_compare', argsJson: JSON.stringify({ left: 'main', right: 'HEAD' }) }, { id: 'c1', name: 'fs_read', argsJson: JSON.stringify({ path: 'secrets/key.pem' }) }, { id: 'c2', name: 'fs_read', argsJson: JSON.stringify({ path: 'src/index.ts' }) }]),
      makeTurn(JSON.stringify({ done: true }), [], { done: true }),
      makeTurn('', [{ id: 'd1', name: 'fs_read', argsJson: JSON.stringify({ path: 'secrets/denied.pem' }) }, { id: 'd2', name: 'fs_read', argsJson: JSON.stringify({ path: 'src/after-denied.ts' }) }]),
      makeTurn(JSON.stringify({ done: true }), [], { done: true }),
    ]);
    const humanAdapter = new ScriptedHumanAdapter([{ grant: true }]);
    const ledger = new InMemoryLedgerStore();
    await ledger.createOrResumeRun({ runId: 'run-1', laneId: 'l1', itemKey: 'k1', inputJson: '{}' });

    let adjCallCount = 0;
    const registry = createExecutorRegistry({
      models: { 'claude:model': () => modelDriver }, tools: { 'fs:read': toolDriver },
      policyGuards: {
        'fs:protect': (guard, input) => {
          const hit = input.proposedEffects.filter((eff) => guard.globs.some((g) => String(eff.attributes?.['path'] ?? '').startsWith(g.replace('/**', ''))));
          return { allowed: hit.length === 0, violatedEffects: hit, violationSummary: `Blocked ${guard.id}` };
        },
      },
      effectMatchers: { 'fs:match-globs': (_m, eff) => String(eff.attributes?.['path'] ?? '').startsWith('secrets/') },
    });
    const makeCtx = (stepExecId: string, grantViaHuman: boolean): StepExecutionContext<GitWorktreeHandle> & { readonly _runtime: unknown } => ({
      runId: 'run-1', stepExecId, scopeHandle: SAMPLE_HANDLE, activePartitions: [], activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined,
      _runtime: {
        ledgerStore: ledger, humanAdaptersById: new Map([[human.id, humanAdapter]]),
        executeChildStep: async () => {
          adjCallCount += 1;
          if (grantViaHuman && adjCallCount === 1) return { status: 'interrupt-raised' as const, interruptId: 'human-esc', interruptPayload: { question: 'Allow secrets?' }, continuationStack: [] };
          return { status: 'completed' as const, output: { allow: grantViaHuman, note: grantViaHuman ? 'Approved' : 'Rejected by adj' }, continuationStack: [] };
        },
      },
    });
    expect(await executeAgent(worker, { task: 'elevate' }, makeCtx('s-elevate', true))).toEqual({ done: true });
    expect(toolDriver.invocations.map((i) => i.toolName)).toEqual(['git_compare', 'fs_read', 'fs_read']);
    expect(await executeAgent(worker, { task: 'deny' }, makeCtx('s-deny', false))).toEqual({ done: true });
    expect(ledger.frames.get('msg:s-deny:tools:1')?.canonical.toolResults).toEqual([
      { callId: 'd1', content: '[Lease Denied: Rejected by adj]', isError: true },
      { callId: 'd2', content: '[Skipped: Preceding tool call in turn batch was denied]', isError: true },
    ]);
  });
});

describe('Post-flight subprocess sandboxing and 4-step .onLimitExceeded() sequence', () => {
  it('persists inFlightPreToolCheckpoint, rolls back subprocess mutations, and appends [Adjudication: ...] on post-flight resumeWith', async () => {
    const scope = new ScriptedBranchableScope();
    const handle = await scope.acquireRoot('run-sb');
    const persistedCheckpoints: Array<string | undefined> = [];
    const intr = M.interrupt('post-intr', z.object({ msg: z.string() }));
    const policy = M.policy<string>('sb-policy').guard(WRITE_GUARD_NODE).onViolation('raise-interrupt', intr, (v: PolicyViolation) => ({ msg: v.violationSummary })).toAST();
    const registry = createExecutorRegistry({ policyGuards: { 'fs:protect': (_guard, input) => ({ allowed: input.proposedEffects.length === 0, violatedEffects: input.proposedEffects, violationSummary: 'Unauthorized subprocess write' }) } });
    const ctx: StepExecutionContext<string> = { runId: 'run-sb', stepExecId: 'step-sb', scopeHandle: handle, activePartitions: [], activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined };

    await expect(executePostFlightSandboxedTool({
      toolNode: SAMPLE_POST_FLIGHT_SUBPROCESS_TOOL_NODE as never, toolDriver: new ScriptedToolDriver<string>({ handler: throwUnusedRunner }), parsedArgs: { cmd: 'rm -rf' },
      callRecord: { callId: 'c-throw', toolName: 'shell_exec', argsJson: '{}' }, policy, activeLeases: [], checkpointScope: scope, ctx,
      persistInFlightCheckpoint: async (ckpt) => { persistedCheckpoints.push(ckpt); },
    })).rejects.toThrow('unused');
    expect([persistedCheckpoints, scope.restoredCheckpoints]).toEqual([['ckpt:root:run-sb:1', undefined], [{ handle: 'root:run-sb', checkpoint: 'ckpt:root:run-sb:1' }]]);

    scope.scriptedDiffEffects = [Object.freeze<ToolEffect>({ kind: 'fs:write', mutatesScope: true, attributes: { path: 'secrets/token' } })];
    const okDriver = new ScriptedToolDriver<string>();
    const unauthorizedRes = await executePostFlightSandboxedTool({
      toolNode: SAMPLE_POST_FLIGHT_SUBPROCESS_TOOL_NODE as never, toolDriver: okDriver, parsedArgs: { cmd: 'touch secrets/token' },
      callRecord: { callId: 'c-diff', toolName: 'shell_exec', argsJson: '{}' }, policy, activeLeases: [], checkpointScope: scope, ctx,
      persistInFlightCheckpoint: async (ckpt) => { persistedCheckpoints.push(ckpt); },
    });
    expect([unauthorizedRes.status, unauthorizedRes.toolResult.isError, unauthorizedRes.toolResult.content]).toEqual([
      'rolled-back-interrupt', true, '[Post-Flight Policy Violation — Workspace Rolled Back: Unauthorized subprocess write]',
    ]);

    const ledger = new InMemoryLedgerStore();
    await ledger.createOrResumeRun({ runId: 'run-sb', laneId: 'l1', itemKey: 'k1', inputJson: '{}' });
    const lockManager = new ScopeLockManager();
    let writeLockedDuringPostFlightRollback = false;
    const origRestore = scope.restoreCheckpoint.bind(scope);
    scope.restoreCheckpoint = async (h, ckpt) => {
      writeLockedDuringPostFlightRollback = lockManager.isWriteLocked(h);
      return origRestore(h, ckpt);
    };
    let persistedBatchDuringInterrupt: unknown;
    const adjModel = new ScriptedModelDriver([
      makeTurn('', [{ id: 'sb-call-1', name: 'shell_exec', argsJson: JSON.stringify({ cmd: 'touch secrets/token' }) }]),
      makeTurn(JSON.stringify({ ok: true }), [], { ok: true }),
    ]);
    const adjAgent = M.agent<string>('adj').model(SAMPLE_MODEL_NODE).input(z.object({ msg: z.string() })).output(z.object({ note: z.string() }));
    const sbWorker = M.agent<string>('sb-worker').model(SAMPLE_MODEL_NODE).policy(policy).tools(SAMPLE_POST_FLIGHT_SUBPROCESS_TOOL_NODE as never)
      .input(z.object({ cmd: z.string() })).output(z.object({ ok: z.boolean() }))
      .onInterrupt(intr, ($i) => $i.adjudicateWith(adjAgent, (_in, p: { readonly msg: string }) => p).resumeWith((_in, _p, out: { readonly note: string }) => out.note)).toAST();
    const sbRegistry = createExecutorRegistry(registry, { models: { 'claude:model': () => adjModel }, tools: { 'node:command-tool': okDriver as never }, scopes: { 'git:cow-worktree': () => scope as never } });
    await executeAgent(sbWorker, { cmd: 'run' }, {
      ...ctx, stepExecId: 'step-sb-agent', scope, registry: sbRegistry,
      _runtime: {
        ledgerStore: ledger, lockManager,
        executeChildStep: async () => {
          const af = ledger.steps.get('step-sb-agent')?.continuationStack.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame');
          persistedBatchDuringInterrupt = af?.pauseState.kind === 'tool-batch' ? af.pauseState.pendingToolBatch : undefined;
          return { status: 'completed' as const, output: { note: 'Use --dry-run instead' }, continuationStack: [] };
        },
      },
    } as StepExecutionContext<string> & { readonly _runtime: unknown });
    expect(writeLockedDuringPostFlightRollback).toBe(true);
    expect(persistedBatchDuringInterrupt).toMatchObject({
      completedResults: [{ callId: 'sb-call-1', content: '[Post-Flight Policy Violation — Workspace Rolled Back: Unauthorized subprocess write]', isError: true }],
      remainingCalls: [], activeInterruptCallId: 'sb-call-1',
    });
    expect(ledger.frames.get('msg:step-sb-agent:tools:1')?.canonical.toolResults?.[0]?.content).toBe(
      '[Post-Flight Policy Violation — Workspace Rolled Back: Unauthorized subprocess write]\n[Adjudication: Use --dry-run instead]',
    );
  });

  it('executes the 4-step .onLimitExceeded() sequence on direct call and when QuotaTripwire trips inside drainPendingToolBatch', async () => {
    const flushIntr = M.interrupt('limit-flush', z.object({ partialSummary: z.string() }));
    const policy = M.policy<GitWorktreeHandle>('limit-policy')
      .maxTurns(1).tripwire(MAX_FILES_TRIPWIRE_NODE)
      .onLimitExceeded(($l: PolicyLimitExceededBuilder<GitWorktreeHandle>) => $l.flushWithInterrupt(flushIntr).onAbort(SAMPLE_ABORT_HOOK_NODE)).toAST();
    if (policy.onLimitExceeded === undefined) throw new Error('Expected onLimitExceeded');

    const ledger = new InMemoryLedgerStore();
    await ledger.createOrResumeRun({ runId: 'run-lim', laneId: 'l1', itemKey: 'k1', inputJson: '{"task":"initial"}' });
    await ledger.recordStepStart({ runId: 'run-lim', stepExecId: 'step-1', stepId: 'fast-path', executableId: 'fast-agent', inputMsgId: null, continuationStack: [] });
    const topology = new InMemoryTopologyStore({ core: { contractText: 'v1', epoch: 1 } });
    await topology.updateContract('run-lim', 'core', 'v2-uncommitted', 'step-1');
    const serviceSession = new ScriptedServiceSession('dev-server');
    const serviceRegistry = new ServiceSessionRegistry();
    const skillNode = M.skill<GitWorktreeHandle>('srv-skill').description('d').instructions('i').unlocksServices(SAMPLE_SERVICE_NODE).toAST() as InlineSkillNode<GitWorktreeHandle>;
    const toolDriver = new ScriptedToolDriver<GitWorktreeHandle>({ describeEffects: () => [Object.freeze<ToolEffect>({ kind: 'fs:write', mutatesScope: true, attributes: { path: 'a.ts' } })] });
    const modelDriver = new ScriptedModelDriver([
      makeTurn(JSON.stringify({ partialSummary: 'Stopped at 80%' }), [], { partialSummary: 'Stopped at 80%' }),
      makeTurn('', [{ id: 'tw-1', name: 'fs_read', argsJson: JSON.stringify({ path: 'a.ts' }) }, { id: 'tw-2', name: 'fs_read', argsJson: JSON.stringify({ path: 'b.ts' }) }]),
      makeTurn(JSON.stringify({ partialSummary: 'Tripwire flushed' }), [], { partialSummary: 'Tripwire flushed' }),
    ]);
    const registry = createExecutorRegistry({
      models: { 'claude:model': () => modelDriver }, tools: { 'fs:read': toolDriver }, services: { 'node:service': async () => serviceSession as never },
      abortHooks: { 'git:snapshot-and-reset': async () => ({ abortedSnapshotRef: 'refs/abort/1', resetToRef: 'HEAD~1' }) },
      quotaTripwires: { 'fs:quota-tripwire': (_tw, input) => ({ tripped: input.accumulatedEffects.length + input.newEffects.length >= 1, reason: 'Exceeded max modified files (1)' }) },
    });
    await serviceRegistry.acquireSkillServices({ runId: 'run-lim', scopeKey: 'step-1', scopeHandle: SAMPLE_HANDLE, skill: skillNode, driverContext: { registry, resolveEnv: () => undefined, getRunner: throwUnusedRunner } });

    const initialFrame: AgentContinuationFrame = Object.freeze({
      kind: 'agent-frame', agentId: 'fast-agent', roleKey: 'fast-agent', modelId: SAMPLE_MODEL_NODE.modelId,
      stepExecId: 'step-1', inputJson: '{"task":"initial"}', leafMessageId: null, turnsTaken: 1, costUsd: 0.05, elapsedDurationMs: 100,
      activeLeases: Object.freeze([]), activeSkillIds: Object.freeze(['srv-skill']), activeSkillActivations: Object.freeze({}),
      observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]),
      accumulatedLessonOutcomes: Object.freeze({ 'L-1': 'clean_pass' as const }), pausedAtPhase: 'TOOL_BOUNDARY', pauseState: Object.freeze({ kind: 'active-turn' }),
    });
    const flushRes = await executeLimitExceededSequence({
      ctx: { runId: 'run-lim', stepExecId: 'step-1', scopeHandle: SAMPLE_HANDLE, activePartitions: ['core'], activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined },
      agentFrame: initialFrame, limitConfig: policy.onLimitExceeded, tripReason: 'Exceeded maxTurns (1)',
      pendingToolBatch: { completedResults: [{ callId: 'c1', content: 'done-1', isError: false }], blockedCalls: [], remainingCalls: [{ callId: 'c2', toolName: 'fs_read', argsJson: '{}' }] },
      modelNode: SAMPLE_MODEL_NODE, modelDriver, ledgerStore: ledger, topologyStore: topology, serviceRegistry,
      replacementPromotion: { stepId: 'fast-path', replacementStepExecId: 'step-1:replace:1', replacementExecutableId: 'deep-loop', mapReplacementInput: (orig, payload, abortMeta) => ({ orig, payload, abortMeta }) },
    });
    expect([flushRes.flushedPayload, modelDriver.recordedRequests[0]?.toolChoice, modelDriver.recordedRequests[0]?.effort, serviceSession.stopCount]).toEqual([{ partialSummary: 'Stopped at 80%' }, 'none', 'low', 1]);
    expect([(await topology.getPartitions('run-lim')).get('core')?.contractText, flushRes.updatedAgentFrame.accumulatedLessonOutcomes, ledger.steps.get('step-1')?.status, ledger.steps.get('step-1:replace:1')?.status]).toEqual(['v1', undefined, 'INTERRUPTED', 'RUNNING']);
    expect(ledger.frames.get('msg:step-1:limit-abort-tools')?.canonical.toolResults).toEqual([
      { callId: 'c1', content: 'done-1', isError: false },
      { callId: 'c2', content: '[Aborted: Limit Exceeded]\n[LIMIT_EXCEEDED_FLUSH] Exceeded maxTurns (1). Summarize state and emit final structured output.', isError: true },
    ]);

    const fallbackAgent = M.agent<GitWorktreeHandle>('fallback-agent').model(SAMPLE_MODEL_NODE).input(z.object({ partialSummary: z.string() })).output(z.object({ recovered: z.string() }));
    const tripAgent = M.agent<GitWorktreeHandle>('trip-agent').model(SAMPLE_MODEL_NODE).policy(policy).tools(SAMPLE_DECLARED_TOOL_NODE)
      .input(z.object({ task: z.string() })).output(z.object({ recovered: z.string() }))
      .onInterrupt(flushIntr, ($i) => $i.replaceWith(fallbackAgent, (_in, p: { readonly partialSummary: string }) => p)).toAST();
    const tripOut = await executeAgent(tripAgent, { task: 'go' }, {
      runId: 'run-lim', stepExecId: 'step-trip', scopeHandle: SAMPLE_HANDLE, activePartitions: ['core'], activeLeases: [], observedEffects: [],
      registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined,
      _runtime: { ledgerStore: ledger, topologyStore: topology, serviceRegistry, executeChildStep: async (_n: unknown, inp: unknown) => ({ status: 'completed' as const, output: { recovered: (inp as { partialSummary: string }).partialSummary }, continuationStack: [] }) },
    } as StepExecutionContext<GitWorktreeHandle> & { readonly _runtime: unknown });
    expect([tripOut, toolDriver.invocations.length]).toEqual([{ recovered: 'Tripwire flushed' }, 1]);
  });
});

describe('M.skill reference-counted ServiceSession lifecycle and M.loop cross-model escalation', () => {
  it('shares reference-counted ServiceSessions across skills, quiesces on step boundaries, and injects [SERVICE_REACQUIRED] on pre-drain and turn-boundary resume', async () => {
    let startCount = 0;
    const sessions: ScriptedServiceSession[] = [];
    const modelDriver = new ScriptedModelDriver([
      makeTurn(JSON.stringify({ ok: true }), [], { ok: true }),
      makeTurn(JSON.stringify({ ok: true }), [], { ok: true }),
    ]);
    const toolDriver = new ScriptedToolDriver<string>({ describeEffects: (_n, args) => [Object.freeze<ToolEffect>({ kind: 'fs:read', mutatesScope: false, attributes: { path: String((args as { path?: string }).path ?? '') } })] });
    const registry = createExecutorRegistry({
      models: { 'claude:model': () => modelDriver }, tools: { 'fs:read': toolDriver },
      policyGuards: { 'fs:protect': (_g, inp) => ({ allowed: !inp.proposedEffects.some((e) => String(e.attributes?.['path'] ?? '').startsWith('secrets/')), violatedEffects: inp.proposedEffects, violationSummary: 'Blocked' }) },
      services: {
        'node:service': async (node) => {
          startCount += 1;
          const session = new ScriptedServiceSession(node.id);
          sessions.push(session);
          return session as never;
        },
      },
    });
    const drvCtx = { registry, resolveEnv: () => undefined, getRunner: throwUnusedRunner };
    const skillA = M.skill<string>('skill-a').description('A').instructions('inst A').unlocksServices(SAMPLE_SERVICE_NODE).unlocksTools(SAMPLE_DECLARED_TOOL_NODE as never).toAST() as InlineSkillNode<string>;
    const skillB = M.skill<string>('skill-b').description('B').instructions('inst B').unlocksServices(SAMPLE_SERVICE_NODE).toAST() as InlineSkillNode<string>;
    const svcRegistry = new ServiceSessionRegistry();

    await svcRegistry.acquireSkillServices({ runId: 'r1', scopeKey: 's1', scopeHandle: 'h1', skill: skillA, driverContext: drvCtx });
    await svcRegistry.acquireSkillServices({ runId: 'r1', scopeKey: 's1', scopeHandle: 'h1', skill: skillB, driverContext: drvCtx });
    expect([startCount, await svcRegistry.releaseSkillServices('s1', 'skill-a'), sessions[0]?.running, await svcRegistry.releaseSkillServices('s1', 'skill-b'), sessions[0]?.stopCount]).toEqual([1, [], true, ['dev-server'], 1]);

    await svcRegistry.acquireSkillServices({ runId: 'r1', scopeKey: 's1', scopeHandle: 'h1', skill: skillA, driverContext: drvCtx });
    await svcRegistry.quiesceScopeServices('s1');
    let secondPrefixStopCount = 0;
    const prefixDrvCtx = {
      registry: createExecutorRegistry({
        services: {
          'node:service': async () => ({
            id: 'dev-server',
            endpoint: 'http://127.0.0.1:0',
            tools: [],
            invokeTool: async () => ({ content: 'ok', isError: false }),
            stop: async () => {
              if (secondPrefixStopCount === 0) {
                secondPrefixStopCount += 1;
                throw new Error('service stop failure');
              }
              secondPrefixStopCount += 1;
            },
          }),
        },
      }),
      resolveEnv: () => undefined,
      getRunner: throwUnusedRunner,
    };
    await svcRegistry.acquireSkillServices({ runId: 'r-prefix', scopeKey: 'r-prefix:step-1:1', scopeHandle: 'h1', skill: skillA, driverContext: prefixDrvCtx });
    await svcRegistry.acquireSkillServices({ runId: 'r-prefix', scopeKey: 'r-prefix:step-2:1', scopeHandle: 'h1', skill: skillB, driverContext: prefixDrvCtx });
    await expect(svcRegistry.quiesceScopeServices('r-prefix')).rejects.toThrow('service stop failure');
    expect([secondPrefixStopCount, svcRegistry.getActiveSessionsForScope('r-prefix:step-2:1').size]).toEqual([2, 0]);
    const ledger = new InMemoryLedgerStore();
    await ledger.createOrResumeRun({ runId: 'r1', laneId: 'l1', itemKey: 'k1', inputJson: '{}' });
    const repIntr = M.interrupt('rep-intr', z.object({ why: z.string() }));
    const repPol = M.policy<string>('rep-pol').guard(WRITE_GUARD_NODE).onViolation('raise-interrupt', repIntr, (v) => ({ why: v.violationSummary })).toAST();
    const repFallback = M.agent<string>('rep-fb').model(SAMPLE_MODEL_NODE).input(z.object({ why: z.string() })).output(z.object({ ok: z.boolean() }));
    const resAgent = M.agent<string>('res-agent').model(SAMPLE_MODEL_NODE).policy(repPol).skills(skillA as never).input(z.object({})).output(z.object({ ok: z.boolean() }))
      .onInterrupt(repIntr, ($i) => $i.replaceWith(repFallback, (_in, p: { readonly why: string }) => p)).toAST();

    const batchResumeFrame: AgentContinuationFrame = Object.freeze({
      kind: 'agent-frame', agentId: 'res-agent', roleKey: 'res-agent', modelId: SAMPLE_MODEL_NODE.modelId, stepExecId: 's1', inputJson: '{}',
      leafMessageId: 'msg:s1:turn:1', turnsTaken: 1, costUsd: 0, elapsedDurationMs: 1, activeLeases: Object.freeze([]), activeSkillIds: Object.freeze(['skill-a']),
      activeSkillActivations: Object.freeze({}), observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]), pausedAtPhase: 'TOOL_BOUNDARY',
      pauseState: Object.freeze({
        kind: 'adjudication', pendingAdjudication: Object.freeze({ interruptId: 'x', interruptPayloadJson: '{}' }),
        pendingToolBatch: Object.freeze({ completedResults: Object.freeze([{ callId: 'c0', content: 'ok-0', isError: false }]), blockedCalls: Object.freeze([]), remainingCalls: Object.freeze([{ callId: 'c1', toolName: 'fs_read', argsJson: '{"path":"ok.ts"}' }]) }),
      }),
    });
    await executeAgent(resAgent, {}, {
      runId: 'r1', stepExecId: 's1', scopeHandle: 'h1', activePartitions: [], activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined,
      resumeContinuationStack: [batchResumeFrame], _runtime: { ledgerStore: ledger, serviceRegistry: svcRegistry },
    } as StepExecutionContext<string> & { readonly _runtime: unknown });
    expect(ledger.frames.get('msg:s1:tools:1')?.canonical.toolResults?.[1]?.content).toContain("[SERVICE_REACQUIRED] Service 'dev-server' was restarted for scope 's1'.");

    await svcRegistry.quiesceScopeServices('s1');
    await ledger.appendMessageFrame('r1', Object.freeze({
      messageId: 'msg:s1:prev-tool', parentMessageId: null, vendorId: 'anthropic', rawWireFrame: new Uint8Array(),
      canonical: Object.freeze({ role: 'tool', visibleText: 'prev-tool', toolResults: Object.freeze([{ callId: 'cp', content: 'prev', isError: false }]) }), prefixDigest: 'p1',
    }));
    const turnResumeFrame: AgentContinuationFrame = Object.freeze({ ...batchResumeFrame, leafMessageId: 'msg:s1:prev-tool', pauseState: Object.freeze({ kind: 'active-turn' }) });
    await executeAgent(resAgent, {}, {
      runId: 'r1', stepExecId: 's1', scopeHandle: 'h1', activePartitions: [], activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined,
      resumeContinuationStack: [turnResumeFrame], _runtime: { ledgerStore: ledger, serviceRegistry: svcRegistry },
    } as StepExecutionContext<string> & { readonly _runtime: unknown });
    expect(ledger.frames.get('msg:s1:prev-tool')?.canonical.visibleText).toContain("[SERVICE_REACQUIRED] Service 'dev-server' was restarted for scope 's1'.");

    const replaceResumeFrame: AgentContinuationFrame = Object.freeze({
      ...batchResumeFrame, stepExecId: 's-rep',
      pauseState: Object.freeze({
        kind: 'adjudication', pendingAdjudication: Object.freeze({ interruptId: 'x', interruptPayloadJson: '{}' }),
        pendingToolBatch: Object.freeze({ completedResults: Object.freeze([]), blockedCalls: Object.freeze([]), remainingCalls: Object.freeze([{ callId: 'c-sec', toolName: 'fs_read', argsJson: '{"path":"secrets/k"}' }]) }),
      }),
    });
    const repOut = await executeAgent(resAgent, {}, {
      runId: 'r1', stepExecId: 's-rep', scopeHandle: 'h1', activePartitions: [], activeLeases: [], observedEffects: [], registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined,
      resumeContinuationStack: [replaceResumeFrame],
      _runtime: { ledgerStore: ledger, serviceRegistry: svcRegistry, executeChildStep: async () => ({ status: 'completed' as const, output: { ok: true }, continuationStack: [] }) },
    } as StepExecutionContext<string> & { readonly _runtime: unknown });
    expect(repOut).toEqual({ ok: true });
  });

  it('preserves actor session with prepareFork(substituteTombstones: true) when true, starts fresh transcript while inheriting grantedLoopLeases when false, and records scopeReceipt in gate failure snapshot', async () => {
    const haiku: ClaudeModelNode = Object.freeze({ type: 'claude:model', vendor: 'anthropic', modelId: 'claude-haiku', alias: 'haiku' });
    const opus: ClaudeModelNode = Object.freeze({ type: 'claude:model', vendor: 'anthropic', modelId: 'claude-opus', alias: 'opus' });
    const modelPool = M.pool<ModelASTNode>('loop-models').with(haiku as ModelASTNode, opus as ModelASTNode).strategy(($s: PoolStrategyConfigurator<ModelASTNode>) => $s.escalateOnRetry()).toAST();
    const skillOne = M.skill<GitWorktreeHandle>('skill-1').description('S1').instructions('Detailed S1').unlocksTools(SAMPLE_DECLARED_TOOL_NODE).toAST();
    const skillTwo = M.skill<GitWorktreeHandle>('skill-2').description('S2').instructions('Detailed S2').unlocksTools(SAMPLE_EXTRA_COMPARE_TOOL_NODE).toAST();
    let gatePass = false;
    const actor = M.agent<GitWorktreeHandle>('loop-actor').model(modelPool).skills(skillOne, skillTwo).beforeStop(SAMPLE_CLEAN_TREE_CHECK_NODE).input(z.object({ goal: z.string() })).output(z.object({ patch: z.string() }));
    const evaluator = M.agent<GitWorktreeHandle>('loop-eval').model(haiku).input(z.object({ patch: z.string() })).output(z.object({ passed: z.boolean(), feedback: z.string() }));

    const loopNode = M.loop<GitWorktreeHandle>('refine-loop')
      .input(z.object({ goal: z.string() })).output(z.object({ patch: z.string() })).maxIterations(2).preserveActorSession(true)
      .act('code', actor)
      .evaluate('review', evaluator, { mapInput: (_in: { readonly goal: string }, actOut: { readonly patch: string }, _r: GitScopeReceipt) => ({ patch: actOut.patch }), acceptWhen: (v: { readonly passed: boolean; readonly feedback: string }) => v.passed, feedbackMapper: (v: { readonly passed: boolean; readonly feedback: string }) => v.feedback })
      .returnOutputFrom('code').toAST();
    const modelDriver = new ScriptedModelDriver([
      makeTurn('', [{ id: 'call-s1', name: 'activateSkill', argsJson: JSON.stringify({ skillId: 'skill-1' }) }, { id: 'call-s2', name: 'activateSkill', argsJson: JSON.stringify({ skillId: 'skill-2' }) }]),
      makeTurn('', [{ id: 'call-c1', name: 'completeSkill', argsJson: JSON.stringify({ skillId: 'skill-1' }) }]),
      makeTurn(JSON.stringify({ patch: 'v1-dirty' }), [], { patch: 'v1-dirty' }), makeTurn(JSON.stringify({ patch: 'v1' }), [], { patch: 'v1' }),
      makeTurn(JSON.stringify({ passed: false, feedback: 'Needs edge case fix' }), [], { passed: false, feedback: 'Needs edge case fix' }),
      makeTurn('', [{ id: 'call-c2', name: 'completeSkill', argsJson: JSON.stringify({ skillId: 'skill-2', summary: 'TOMBSTONE_S2_AFTER_FORK' }) }]),
      makeTurn(JSON.stringify({ patch: 'v2-fixed' }), [], { patch: 'v2-fixed' }), makeTurn(JSON.stringify({ passed: true, feedback: 'LGTM' }), [], { passed: true, feedback: 'LGTM' }),
      makeTurn(JSON.stringify({ patch: 'fresh-iter-0' }), [], { patch: 'fresh-iter-0' }), makeTurn(JSON.stringify({ passed: false, feedback: 'retry fresh' }), [], { passed: false, feedback: 'retry fresh' }),
      makeTurn(JSON.stringify({ patch: 'fresh-iter-1' }), [], { patch: 'fresh-iter-1' }), makeTurn(JSON.stringify({ passed: true, feedback: 'ok fresh' }), [], { passed: true, feedback: 'ok fresh' }),
    ]);
    const ledger = new InMemoryLedgerStore();
    await ledger.createOrResumeRun({ runId: 'run-loop', laneId: 'l1', itemKey: 'k1', inputJson: '{}' });
    const scope = new ScriptedBranchableScope();
    await scope.acquireRoot('run-loop');
    const registry = createExecutorRegistry({
      models: { 'claude:model': () => modelDriver }, tools: { 'fs:read': new ScriptedToolDriver() }, scopes: { 'git:cow-worktree': () => scope as never },
      checks: { 'git:clean-working-tree': async () => (!gatePass ? ((gatePass = true), { ok: false, deficits: ['uncommitted file'] }) : { ok: true, deficits: [] }) },
    });
    let capturedGateFailureJson: string | undefined;
    const origUpdateStack = ledger.updateContinuationStack.bind(ledger);
    ledger.updateContinuationStack = async (rId, sId, stack, opts) => {
      const af = stack.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame');
      if (af?.lastGateFailureJson !== undefined) capturedGateFailureJson = af.lastGateFailureJson;
      return origUpdateStack(rId, sId, stack, opts);
    };
    const ctx: StepExecutionContext<GitWorktreeHandle> & { readonly _runtime: unknown } = {
      runId: 'run-loop', stepExecId: 'step-loop', scopeHandle: SAMPLE_HANDLE, scopeNode: SAMPLE_TIER3_SCOPE_NODE as never, scope: scope as never, activePartitions: [], activeLeases: [], observedEffects: [],
      registry, resolveEnv: () => '', getRunner: throwUnusedRunner, recordEffects: () => undefined, _runtime: { ledgerStore: ledger, poolManager: new PoolManager(), lessonStore: new InMemoryLessonStore() },
    };
    expect(await executeLoop(loopNode, { goal: 'ship feature' }, ctx)).toEqual({ patch: 'v2-fixed' });
    expect(JSON.parse(capturedGateFailureJson ?? '{}')).toHaveProperty('scopeReceipt');
    expect([modelDriver.recordedForks.length, modelDriver.recordedForks[0]?.target.modelId, modelDriver.recordedForks[0]?.target.substituteTombstones]).toEqual([1, 'claude-opus', true]);
    expect(Array.from(ledger.tombstones.values())).toEqual(expect.arrayContaining(["[Skill 'skill-1' completed and unmounted]", 'TOMBSTONE_S2_AFTER_FORK']));
    expect(ledger.frames.get('msg:step-loop:assistant:1')?.compactedTombstones?.['call-s1']).toBe("[Skill 'skill-1' completed and unmounted]");
    expect(Array.from(ledger.tombstones.keys()).find((k) => k.endsWith(':call-s2'))?.startsWith('fork:1:')).toBe(true);

    const freshLoopNode = Object.freeze({ ...loopNode, preserveActorSession: false });
    const leaseDelta: LeaseDelta = Object.freeze({ type: 'harness:lease-delta', id: 'loop-inherited-lease', grantedMatchers: Object.freeze([GLOB_MATCHER_NODE]) });
    expect([await executeLoop(freshLoopNode, { goal: 'fresh' }, { ...ctx, stepExecId: 'step-loop-fresh', activeLeases: [leaseDelta] }), modelDriver.recordedForks.length]).toEqual([{ patch: 'fresh-iter-1' }, 1]);
  });
});
