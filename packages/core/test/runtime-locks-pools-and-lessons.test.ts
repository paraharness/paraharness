import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  H, type LessonDistillationBuilder, type LessonRecord, type LessonRetirementBuilder,
  type LessonScoringBuilder, type LessonSignalTriggerBuilder, PoolManager,
  type PoolStrategyConfigurator, ScopeLockManager, type SourcedScopedRuleNode,
  type SourcedSkillNode, StepContinuationQueue, buildRoleAndScopeContextFrame,
  compileRunWirePrefixes, computeInRunGroundingDiffs, computeLessonScore,
  createExecutorRegistry, evaluateLessonSignalTriggers, executeAgent, executeLoop,
  flushStepLessonOutcomes, mergeLessonOutcomePrecedence, runContrastiveLessonDistillation,
  selectRecalledLessons, shouldRetireLesson,
} from '../src/index.js';
import type { ClaudeAccountSeatNode } from '../src/ast/domain/claude-account-seat-node.js';
import type { ClaudeModelNode } from '../src/ast/domain/claude-model-node.js';
import type { FsTextSourceNode } from '../src/ast/domain/fs-text-source-node.js';
import type { StepExecutionContext } from '../src/ports/step-execution-context.js';
import { InMemoryLedgerStore } from './fixtures/in-memory-ledger-store.js';
import { InMemoryLessonStore } from './fixtures/in-memory-lesson-store.js';
import { InMemoryTopologyStore } from './fixtures/in-memory-topology-store.js';
import {
  SAMPLE_DECLARED_TOOL_NODE, SAMPLE_EXTRA_COMPARE_TOOL_NODE, SAMPLE_LESSON_STORE_NODE,
} from './fixtures/sample-domain-nodes.constants.js';
import { ScriptedModelDriver } from './fixtures/scripted-model-driver.js';
import { ScriptedToolDriver } from './fixtures/scripted-tool-driver.js';

function createDeferred<T = void>(): { readonly promise: Promise<T>; readonly resolve: (value: T | PromiseLike<T>) => void } {
  let resolveFn: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

function makeSeat(id: string): ClaudeAccountSeatNode {
  return Object.freeze({ type: 'claude:account-seat', id });
}
function makeModel(modelId: string, alias: string = modelId): ClaudeModelNode {
  return Object.freeze({ type: 'claude:model', vendor: 'anthropic', modelId, alias });
}
function makeSource(id: string, path: string): FsTextSourceNode {
  return Object.freeze({ type: 'fs:text-source', id, path });
}
function makeOutTurn<T>(output: T) {
  return { wireFrame: new Uint8Array(), canonical: { role: 'assistant' as const, visibleText: JSON.stringify(output), toolCalls: [] }, structuredOutput: output, usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.001 } };
}

describe('ScopeLockManager & StepContinuationQueue', () => {
  it('allows concurrent shared readers while serializing exclusive writers in FIFO order without starvation', async () => {
    const locks = new ScopeLockManager();
    const events: string[] = [];
    const r1Started = createDeferred();
    const r2Started = createDeferred();
    const releaseReaders = createDeferred();
    const w1Started = createDeferred();
    const releaseW1 = createDeferred();

    const r1 = locks.withReadLock('scope-1', async () => {
      events.push('r1:enter');
      r1Started.resolve();
      await releaseReaders.promise;
      events.push('r1:exit');
    });
    const r2 = locks.withReadLock('scope-1', async () => {
      events.push('r2:enter');
      r2Started.resolve();
      await releaseReaders.promise;
      events.push('r2:exit');
    });
    await Promise.all([r1Started.promise, r2Started.promise]);
    expect(events).toEqual(['r1:enter', 'r2:enter']);

    const w1 = locks.withWriteLock('scope-1', async () => {
      events.push('w1:enter');
      w1Started.resolve();
      await releaseW1.promise;
      events.push('w1:exit');
    });
    const r3 = locks.withReadLock('scope-1', async () => {
      events.push('r3:enter');
    });

    releaseReaders.resolve();
    await w1Started.promise;
    expect(events).toEqual(['r1:enter', 'r2:enter', 'r1:exit', 'r2:exit', 'w1:enter']);

    releaseW1.resolve();
    await Promise.all([r1, r2, w1, r3]);
    expect(events).toEqual(['r1:enter', 'r2:enter', 'r1:exit', 'r2:exit', 'w1:enter', 'w1:exit', 'r3:enter']);
  });

  it('serializes StepContinuationQueue updates per stepExecId and continues after a task rejection', async () => {
    const queue = new StepContinuationQueue();
    const order: string[] = [];
    const gate = createDeferred();

    const p1 = queue.enqueueUpdate('step-1', async () => {
      await gate.promise;
      order.push('first');
      return 1;
    });
    const p2 = queue.enqueueUpdate('step-1', async () => {
      order.push('second-throws');
      throw new Error('simulated stack failure');
    });
    const p3 = queue.enqueueUpdate('step-1', async () => {
      order.push('third');
      return 3;
    });

    expect(order).toEqual([]);
    gate.resolve();
    await expect(p1).resolves.toBe(1);
    await expect(p2).rejects.toThrow('simulated stack failure');
    await expect(p3).resolves.toBe(3);
    expect(order).toEqual(['first', 'second-throws', 'third']);
    queue.clearStep('step-1');
  });
});

describe('PoolManager run-sticky seats, HTTP 429 failover, and model escalation', () => {
  it('maintains run-sticky seat affinity and fails over on HTTP 429 rate-limit until resetAtMs', () => {
    const poolManager = new PoolManager();
    const seatA = makeSeat('seat-a');
    const seatB = makeSeat('seat-b');
    const fallbackSeat = makeSeat('seat-fallback');
    const seatPool = H.pool<ClaudeAccountSeatNode>('seats').with(seatA, seatB).strategy('round-robin').fallback(fallbackSeat).toAST();

    expect(poolManager.selectSeat(seatPool, 'run-1', 1_000).id).toBe('seat-a');
    expect(poolManager.selectSeat(seatPool, 'run-1', 1_100).id).toBe('seat-a');

    poolManager.recordRateLimit429(seatPool.id, 'seat-a', 5_000);
    expect(poolManager.selectSeat(seatPool, 'run-1', 2_000).id).toBe('seat-b');

    poolManager.recordRateLimit429(seatPool.id, 'seat-b', 5_000);
    expect(poolManager.selectSeat(seatPool, 'run-1', 2_500).id).toBe('seat-fallback');
    expect(poolManager.selectSeat(seatPool, 'run-2', 6_000).id).toBe('seat-a');
    poolManager.releaseRunSeats('run-1');
  });

  it('escalates model tiers on retry attempts and when empirical completion rate drops below minSuccessRate', () => {
    const poolManager = new PoolManager();
    const haiku = makeModel('claude-haiku', 'haiku');
    const sonnet = makeModel('claude-sonnet', 'sonnet');
    const opus = makeModel('claude-opus', 'opus');
    const modelPool = H.pool<ClaudeModelNode>('models')
      .with(haiku, sonnet, opus)
      .strategy(($s: PoolStrategyConfigurator<ClaudeModelNode>) => $s.escalateOnRetry().minSuccessRate(0.75).minSamples(4))
      .toAST();

    expect(poolManager.selectModel(modelPool, 'run-1', 0).modelId).toBe('claude-haiku');
    expect(poolManager.selectModel(modelPool, 'run-1', 1).modelId).toBe('claude-sonnet');
    expect(poolManager.selectModel(modelPool, 'run-1', 2).modelId).toBe('claude-opus');

    poolManager.recordModelOutcome(modelPool.id, 'claude-haiku', true);
    poolManager.recordModelOutcome(modelPool.id, 'claude-haiku', false);
    poolManager.recordModelOutcome(modelPool.id, 'claude-haiku', false);
    poolManager.recordModelOutcome(modelPool.id, 'claude-haiku', false);
    expect(poolManager.selectModel(modelPool, 'run-2', 0).modelId).toBe('claude-sonnet');
  });
});

describe('H.prefixGroup compilation, in-run grounding diffs, and toolsMode', () => {
  it('pins systemPromptText at byte 0, computes in-run grounding diffs on scope mutation, and honours role-scoped vs union toolsMode', async () => {
    const registry = createExecutorRegistry({
      sources: {
        'fs:text-source': async (node, _input, ctx) => {
          const text = ctx.scopeHandle === 'mutated-worktree' && node.id === 'src:arch' ? 'ARCH_V2_MUTATED' : node.path;
          return { content: text, digest: `sha:${text}` };
        },
      },
    });

    const roleScopedGroup = H.prefixGroup('pg-role')
      .sharedGrounding(makeSource('src:arch', 'ARCH_V1'))
      .sharedInstructions(makeSource('src:inst', 'SHARED_INSTRUCTIONS'))
      .sharedRules(H.rules('r-global').global({ id: 'rule-1', directive: 'Never force push' }))
      .toolsMode('role-scoped')
      .toAST();
    const unionGroup = H.prefixGroup('pg-union').sharedGrounding(makeSource('src:arch', 'ARCH_V1')).toolsMode('union').toAST();

    const readerAgent = H.agent('reader').model(makeModel('sonnet')).prefixGroup(roleScopedGroup).tools(SAMPLE_DECLARED_TOOL_NODE).input(z.unknown()).output(z.string()).toAST();
    const writerAgent = H.agent('writer').model(makeModel('sonnet')).prefixGroup(roleScopedGroup).tools(SAMPLE_EXTRA_COMPARE_TOOL_NODE).input(z.unknown()).output(z.string()).toAST();
    const unionReader = H.agent('u-reader').model(makeModel('sonnet')).prefixGroup(unionGroup).tools(SAMPLE_DECLARED_TOOL_NODE).input(z.unknown()).output(z.string()).toAST();
    const unionWriter = H.agent('u-writer').model(makeModel('sonnet')).prefixGroup(unionGroup).tools(SAMPLE_EXTRA_COMPARE_TOOL_NODE).input(z.unknown()).output(z.string()).toAST();

    const resolutionContext = Object.freeze({ runId: 'run-1', activePartitions: Object.freeze(['core']), observedEffects: Object.freeze([]), resolveEnv: () => '' });
    const compiled = await compileRunWirePrefixes({
      prefixGroups: [roleScopedGroup, unionGroup],
      actors: [readerAgent, writerAgent, unionReader, unionWriter],
      registry,
      resolutionContext,
    });

    const roleCompiled = compiled.get('pg-role');
    const unionCompiled = compiled.get('pg-union');
    if (roleCompiled === undefined || unionCompiled === undefined) {
      throw new Error('Expected compiled prefixes');
    }
    expect(roleCompiled.systemPromptText).toBe('ARCH_V1\n\nSHARED_INSTRUCTIONS\n\n[Rule: rule-1] Never force push');
    expect(roleCompiled.wireToolSchemasByRoleKey[readerAgent.roleKey]?.map((t) => t.name)).toEqual(['fs_read']);
    expect(roleCompiled.wireToolSchemasByRoleKey[writerAgent.roleKey]?.map((t) => t.name)).toEqual(['git_compare']);
    expect(unionCompiled.wireToolSchemasByRoleKey['*']?.map((t) => t.name)).toEqual(['fs_read', 'git_compare']);

    const diffs = await computeInRunGroundingDiffs({
      prefixGroup: roleScopedGroup,
      compiledPrefix: roleCompiled,
      scopeHandle: 'mutated-worktree',
      registry,
      resolutionContext,
    });
    expect(diffs).toEqual([
      { sourceId: 'src:arch', previousDigest: 'sha:ARCH_V1', currentDigest: 'sha:ARCH_V2_MUTATED', updatedText: 'ARCH_V2_MUTATED' },
    ]);
    expect(roleCompiled.systemPromptText.startsWith('ARCH_V1')).toBe(true);

    const contextFrame = buildRoleAndScopeContextFrame({
      agentId: 'reader',
      roleKey: readerAgent.roleKey,
      activePartitions: ['core'],
      updatedGroundingDiffs: diffs,
    });
    expect(contextFrame).toContain('Updated Grounding Diffs:');
    expect(contextFrame).toContain('ARCH_V2_MUTATED');
  });
});

describe('H.lessons scoring, retirement, outcome deduplication, _harnessMeta, distillation, and signals', () => {
  it('computes exact Score(L, Q) math and enforces 3-way disjunction retirement including 0/0 protection and gate_rejected_recovered eviction', () => {
    const lessonsNode = H.lessons('lessons-1')
      .store(SAMPLE_LESSON_STORE_NODE)
      .scoring(($s: LessonScoringBuilder) =>
        $s.slidingWindowInjections(6).partitionMatchBoost(0.5).decayOnPartitionEpochChange(0.8).recall({ maxItems: 5, minScore: 0.2 }),
      )
      .retireAfter(($r: LessonRetirementBuilder) => $r.maxViolations(3).orMinCleanPassRate(0.5, { afterInjections: 4 }))
      .toAST();

    const lesson: LessonRecord = Object.freeze<LessonRecord>({
      id: 'L-1', partition: 'auth', directive: 'Always validate JWT exp claim', epochAtCreation: 2,
      recentOutcomes: Object.freeze(['clean_pass', 'clean_pass', 'gate_rejected_recovered', 'violated']),
      totalCleanPasses: 2, totalViolated: 1, relevanceScore: 0.9,
    });

    const score = computeLessonScore(lesson, lessonsNode.scoring, { activePartitions: ['auth'], currentPartitionEpoch: 4 });
    const expectedReliability = (2 + 1) / (2 + 2 * 1 + 0.5 * 1 + 2);
    const expectedScore = 0.9 * (1 + 0.5) * Math.pow(0.8, 2) * expectedReliability;
    expect(score).toBeCloseTo(expectedScore, 10);

    const recalled = selectRecalledLessons([lesson], lessonsNode.scoring, { activePartitions: ['auth'], currentPartitionEpoch: 4 });
    expect(recalled.map((l) => l.id)).toEqual(['L-1']);

    const zeroNeffRecovered: LessonRecord = Object.freeze<LessonRecord>({
      id: 'L-zero-neff', directive: 'Noisy lesson', epochAtCreation: 1,
      recentOutcomes: Object.freeze(['gate_rejected_recovered', 'gate_rejected_recovered', 'gate_rejected_recovered', 'gate_rejected_recovered']),
      totalCleanPasses: 0, totalViolated: 0,
    });
    expect(shouldRetireLesson(zeroNeffRecovered, lessonsNode.retireAfter, 6)).toBe(true);

    const fewRecovered: LessonRecord = Object.freeze<LessonRecord>({ ...zeroNeffRecovered, recentOutcomes: Object.freeze(['gate_rejected_recovered', 'gate_rejected_recovered']) });
    expect(shouldRetireLesson(fewRecovered, lessonsNode.retireAfter, 6)).toBe(false);
  });

  it('deduplicates 4-state outcomes, resolves sourced skills/rules/grounding/queryFrom, honours recordOutcomes: false, and enforces _harnessMeta.violatedLessonIds + .onLoopRecovery()', async () => {
    expect(mergeLessonOutcomePrecedence(undefined, 'clean_pass')).toBe('clean_pass');
    expect(mergeLessonOutcomePrecedence('clean_pass', 'gate_rejected_recovered')).toBe('gate_rejected_recovered');
    expect(mergeLessonOutcomePrecedence('gate_rejected_recovered', 'gate_rejected_unrecovered')).toBe('gate_rejected_unrecovered');
    expect(mergeLessonOutcomePrecedence('gate_rejected_unrecovered', 'violated')).toBe('violated');
    expect(mergeLessonOutcomePrecedence('violated', 'clean_pass')).toBe('violated');

    const promoteSig = H.signal('sig:promote', z.object({ id: z.string(), directive: z.string() }));
    const distillerModel = makeModel('distiller-sonnet');
    const lessonsBuilder = H.lessons<{ readonly task: string }>('lessons-main')
      .store(SAMPLE_LESSON_STORE_NODE)
      .queryFrom(z.object({ task: z.string() }), (inp: { readonly task: string }) => `custom-query:${inp.task}`)
      .scoring(($s: LessonScoringBuilder) => $s.recall({ maxItems: 5, minScore: 0.1 }))
      .distillWith(distillerModel, ($d: LessonDistillationBuilder) =>
        $d.onLoopRecovery().onGateRecovery({ minFailedChecks: 1 }).guidelines('Extract reusable rules'),
      )
      .retireAfter(($r: LessonRetirementBuilder) => $r.maxViolations(2))
      .emitSignalWhen(
        promoteSig,
        ($t: LessonSignalTriggerBuilder) => $t.minCleanPasses(2).maxViolations(0).cooldownHours(24),
        (l: LessonRecord) => ({ id: l.id, directive: l.directive }),
      );
    const lessonsNode = lessonsBuilder.toAST();

    const lessonStore = new InMemoryLessonStore([
      Object.freeze<LessonRecord>({ id: 'L-clean', partition: 'core', directive: 'Keep functions under 80 lines', epochAtCreation: 1, recentOutcomes: Object.freeze(['clean_pass']), totalCleanPasses: 1, totalViolated: 0, relevanceScore: 0.95 }),
      Object.freeze<LessonRecord>({ id: 'L-violated', partition: 'core', directive: 'Never use inline comments', epochAtCreation: 1, recentOutcomes: Object.freeze(['violated']), totalCleanPasses: 0, totalViolated: 1, relevanceScore: 0.95 }),
    ]);

    const emittedSignals: Array<{ readonly signalId: string; readonly payload: unknown }> = [];
    const retired = await flushStepLessonOutcomes({
      lessonsNode,
      lessonStore,
      accumulatedOutcomes: { 'L-clean': 'clean_pass', 'L-violated': 'violated' },
      emitSignal: async (signalId, payload) => {
        emittedSignals.push({ signalId, payload });
      },
      nowIso: '2026-05-01T12:00:00.000Z',
    });

    expect(retired).toEqual(['L-violated']);
    expect(lessonStore.retiredIds.has('L-violated')).toBe(true);
    expect(emittedSignals).toEqual([{ signalId: 'sig:promote', payload: { id: 'L-clean', directive: 'Keep functions under 80 lines' } }]);

    const updatedClean = lessonStore.lessons.get('L-clean');
    if (updatedClean === undefined) {
      throw new Error('Expected L-clean');
    }
    const secondEmit = await evaluateLessonSignalTriggers({ lessonsNode, lessonStore, updatedLessons: [updatedClean], nowIso: '2026-05-01T18:00:00.000Z' });
    expect(secondEmit).toEqual([]);

    const topologyStore = new InMemoryTopologyStore({ core: { contractText: 'v1', epoch: 3 } });
    await topologyStore.updateContract('run-1', 'core', 'v2', 'step-1');
    const modelDriver = new ScriptedModelDriver([
      makeOutTurn({ admit: true, partition: 'core', directive: 'Validate boundary inputs with Zod' }),
      makeOutTurn({ approved: false, _harnessMeta: { violatedLessonIds: ['L-clean'] } }),
      makeOutTurn({ patch: 'v1' }),
      makeOutTurn({ passed: true, feedback: 'violated L-clean', _harnessMeta: { violatedLessonIds: ['L-clean'] } }),
      makeOutTurn({ patch: 'v2' }),
      makeOutTurn({ passed: true, feedback: 'clean', _harnessMeta: { violatedLessonIds: [] } }),
      makeOutTurn({ admit: true, partition: 'core', directive: 'Loop recovery distilled rule' }),
    ]);

    const registry = createExecutorRegistry({
      models: { 'claude:model': () => modelDriver },
      tools: { 'fs:read': new ScriptedToolDriver() },
      sources: { 'fs:text-source': async (node) => ({ content: node.path, digest: `sha:${node.path}` }) },
    });
    const ledger = new InMemoryLedgerStore();
    await ledger.createOrResumeRun({ runId: 'run-1', laneId: 'lane-1', itemKey: 'item-1', inputJson: '{}' });
    const ctx: StepExecutionContext<string> & { readonly _runtime: unknown } = {
      runId: 'run-1', stepExecId: 'step-1', scopeHandle: 'root:run-1', activePartitions: ['core'],
      activeLeases: [], observedEffects: [], signal: new AbortController().signal, registry,
      resolveEnv: () => '',
      getRunner: () => {
        throw new Error('unused');
      },
      recordEffects: () => undefined, _runtime: { ledgerStore: ledger, lessonStore, topologyStore },
    };

    const admittedId = await runContrastiveLessonDistillation({
      lessonsNode, lessonStore, topologyStore, ctx,
      trajectory: { source: 'gate', rejected: { output: 'bad', failedChecks: ['check:lint'], deficits: ['lint failed'] }, accepted: { output: 'good' } },
    });
    expect(admittedId).toBe('lesson-3');
    expect(lessonStore.lessons.get('lesson-3')?.epochAtCreation).toBe(4);

    const sourcedSkill: SourcedSkillNode<string> = Object.freeze({
      type: 'harness:skill', id: 'sourced-skill-1', description: 'Sourced skill desc',
      when: Object.freeze({ partitions: ['core'] }), source: makeSource('src:skill', 'SOURCED_SKILL_BODY'),
      unlockedTools: Object.freeze([]), unlockedServices: Object.freeze([]), leaseMode: 'until-completed-or-fork-exit',
    });
    const sourcedRule: SourcedScopedRuleNode = Object.freeze({
      type: 'harness:scoped-rule', id: 'sourced-rule-1', when: Object.freeze({ partitions: ['core'] }),
      source: makeSource('src:rule', 'SOURCED_RULE_DIRECTIVE'), enforceBeforeStopChecks: Object.freeze([]),
    });

    const evalAgent = H.agent<string>('eval-agent')
      .model(distillerModel).grounding(makeSource('src:actor-g', 'ACTOR_GROUNDING_TEXT')).instructions(makeSource('src:actor-i', 'ACTOR_INSTRUCTION_TEXT'))
      .skills(sourcedSkill).rules(H.rules('sourced-rules').scoped(sourcedRule)).lessons(lessonsBuilder, { recordOutcomes: false })
      .input(z.object({ task: z.string() })).output(z.object({ approved: z.boolean() })).toAST();

    const batchesBeforeEval = lessonStore.recordedBatches.length;
    const out = await executeAgent(evalAgent, { task: 'check' }, ctx);
    expect(out).toEqual({ approved: false });
    expect(lessonStore.recordedQueries[0]).toEqual({ queryText: 'custom-query:check', partitions: ['core'] });
    expect(lessonStore.recordedBatches.length).toBe(batchesBeforeEval);
    const turn0Text = ledger.frames.get('msg:step-1:turn-0')?.canonical.visibleText ?? '';
    expect(turn0Text).toContain('Grounding:\nACTOR_GROUNDING_TEXT');
    expect(turn0Text).toContain('Role Instructions:\nACTOR_INSTRUCTION_TEXT');
    expect(turn0Text).toContain('- sourced-skill-1 [HIGHLIGHTED]: Sourced skill desc');
    expect(turn0Text).toContain('SOURCED_RULE_DIRECTIVE');

    const seenEvalOutputs: Array<Record<string, unknown>> = [];
    const loopActor = H.agent<string>('loop-actor').model(distillerModel).input(z.object({ task: z.string() })).output(z.object({ patch: z.string() }));
    const loopEvaluator = H.agent<string>('loop-eval').model(distillerModel).input(z.object({ patch: z.string() })).output(z.object({ passed: z.boolean(), feedback: z.string() }));
    const loopNode = H.loop<string>('distill-loop')
      .input(z.object({ task: z.string() })).output(z.object({ patch: z.string() })).maxIterations(2)
      .distillLessonsInto(lessonsBuilder)
      .act('act-step', loopActor)
      .evaluate('eval-step', loopEvaluator, {
        mapInput: (_in, actOut: { readonly patch: string }) => ({ patch: actOut.patch }),
        acceptWhen: (v: { readonly passed: boolean; readonly feedback: string }) => {
          seenEvalOutputs.push(v);
          return v.passed;
        },
        feedbackMapper: (v: { readonly passed: boolean; readonly feedback: string }) => v.feedback,
      })
      .returnOutputFrom('act-step')
      .toAST();

    const loopOut = await executeLoop(loopNode, { task: 'loop-task' }, { ...ctx, stepExecId: 'step-loop-distill' });
    expect(loopOut).toEqual({ patch: 'v2' });
    expect(seenEvalOutputs).toEqual([{ passed: true, feedback: 'violated L-clean' }, { passed: true, feedback: 'clean' }]);
    expect(lessonStore.lessons.get('lesson-4')?.directive).toBe('Loop recovery distilled rule');
  });
});
