import { describe, expect, it } from 'vitest';
import {
  BudgetApprovalSchema,
  type ExecutionContext,
  type GitScopeReceipt,
  type GitWorktreeHandle,
  H,
  type LessonDistillationBuilder,
  type LessonRecord,
  type LessonRetirementBuilder,
  type LessonScoringBuilder,
  type LessonSignalTriggerBuilder,
  type PolicyLimitExceededBuilder,
  type PolicyViolation,
  type PoolCandidateState,
  type PoolSelectionContext,
  type PoolStrategyConfigurator,
  affectedBy,
  createExecutorRegistry,
  dependentsOf,
  z,
} from '../src/index.js';
import {
  BidirectionalHumanChannelNode,
  DeclaredToolNode,
  ExtraCompareToolNode,
  ExtraSearchToolNode,
  SampleAbortHookNode,
  SampleCleanTreeCheckNode,
  SampleGuardNode,
  SampleLessonStoreNode,
  SampleModelNode,
  SampleScopeReceiptSchema,
  SampleStreamSourceNode,
  SampleTopologyStoreNode,
} from './fixtures/sample-domain-nodes.constants.js';

describe('H.topology DAG validation and graph queries', () => {
  const prMergedSignal = H.signal('pr-merged').payload(
    z.object({ runId: z.string(), prNumber: z.number() }),
  );

  it('compiles a valid topology DAG and computes dependentsOf and affectedBy', () => {
    const repoTopology = H.topology('repo-contracts')
      .store(SampleTopologyStoreNode)
      .partitions({
        db: { dependsOn: [] },
        api: { dependsOn: ['db'] },
        web: { dependsOn: ['api'] },
      })
      .commitOverlayWhen({
        onSignal: {
          signal: prMergedSignal,
          correlateBy: (payload: { readonly runId: string; readonly prNumber: number }) =>
            payload.runId,
        },
      });

    expect(repoTopology.dependentsOf('db')).toEqual(['api', 'web']);
    expect(repoTopology.dependentsOf('api')).toEqual(['web']);
    expect(repoTopology.dependentsOf('web')).toEqual([]);
    expect(repoTopology.affectedBy('db')).toEqual(['db', 'api', 'web']);

    const ast = repoTopology.toAST();
    expect(Object.isFrozen(ast)).toBe(true);
    expect(dependentsOf(ast, 'db')).toEqual(['api', 'web']);
    expect(affectedBy(ast, 'db')).toEqual(['db', 'api', 'web']);
  });

  it('rejects unknown dependencies, self-cycles, and multi-node cycles in H.topology', () => {
    expect(() =>
      H.topology('unknown-dep')
        .store(SampleTopologyStoreNode)
        .partitions<string>({
          db: { dependsOn: ['missing'] },
        }),
    ).toThrowError(
      "Topology 'unknown-dep' partition 'db' depends on unknown partition 'missing'.",
    );

    expect(() =>
      H.topology('self-cycle')
        .store(SampleTopologyStoreNode)
        .partitions({
          db: { dependsOn: ['db'] },
        }),
    ).toThrowError(
      "Topology 'self-cycle' contains a self-dependency cycle on partition 'db' (db -> db).",
    );

    expect(() =>
      H.topology('multi-cycle')
        .store(SampleTopologyStoreNode)
        .partitions({
          db: { dependsOn: ['web'] },
          api: { dependsOn: ['db'] },
          web: { dependsOn: ['api'] },
        }),
    ).toThrowError("Topology 'multi-cycle' contains a dependency cycle: db -> web -> api -> db.");
  });
});

describe('Primitive and context builders (signal, interrupt, stream, pool, prefixGroup, rules, skill, lessons, policy, human, command)', () => {
  it('maintains copy-on-write immutability and deep-freeze across signal, interrupt, stream, and pool builders', () => {
    const baseSignal = H.signal('base-sig');
    const typedSignal = baseSignal.payload(z.object({ ok: z.boolean().default(true) }));
    expect(baseSignal.toAST()).not.toBe(typedSignal.toAST());
    expect(typedSignal.id).toBe('base-sig');
    expect(typedSignal.type).toBe('harness:signal');

    const streamNode = H.stream('gh-webhooks')
      .source(SampleStreamSourceNode)
      .filter((ev: { readonly prNumber: number; readonly merged: boolean }) => ev.merged)
      .emitSignal(typedSignal, (ev: { readonly prNumber: number; readonly merged: boolean }) => ({
        ok: ev.prNumber > 0,
      }))
      .toAST();
    expect(streamNode.type).toBe('harness:stream');
    expect(streamNode.signal.id).toBe('base-sig');
    expect(Object.isFrozen(streamNode)).toBe(true);

    const customSelector = (
      candidates: readonly PoolCandidateState<typeof SampleModelNode>[],
      _ctx: PoolSelectionContext,
    ): typeof SampleModelNode => candidates[0]?.item ?? SampleModelNode;

    const poolSoonest = H.pool('models-soonest')
      .with(SampleModelNode)
      .strategy('soonest-reset')
      .fallback(SampleModelNode)
      .toAST();
    const poolRoundRobin = H.pool('models-rr')
      .with(SampleModelNode)
      .strategy('round-robin')
      .toAST();
    const poolLeastUsed = H.pool('models-lu')
      .with(SampleModelNode)
      .strategy('least-used')
      .toAST();
    const poolEscalate = H.pool('models-esc')
      .with(SampleModelNode)
      .strategy(($s: PoolStrategyConfigurator<typeof SampleModelNode>) =>
        $s.escalateOnRetry().minSuccessRate(0.8).minSamples(5),
      )
      .toAST();
    const poolCustom = H.pool('models-custom')
      .with(SampleModelNode)
      .strategy(customSelector)
      .toAST();

    expect(poolSoonest.strategy.strategyKind).toBe('soonest-reset');
    expect(poolRoundRobin.strategy.strategyKind).toBe('round-robin');
    expect(poolLeastUsed.strategy.strategyKind).toBe('least-used');
    expect(poolEscalate.strategy.strategyKind).toBe('escalate-on-retry');
    expect(poolCustom.strategy.strategyKind).toBe('custom');
  });

  it('builds prefixGroup, rules, scopedRule, skill, lessons, policy (.extend), human, and command AST nodes', () => {
    const prefixNode = H.prefixGroup('shared-prefix')
      .toolsMode('union')
      .sharedGrounding('Follow repository safety rules.')
      .sharedInstructions('Never skip tests.')
      .toAST();
    expect(prefixNode.toolsMode).toBe('union');
    expect(prefixNode.sharedGrounding.length).toBe(1);

    const scopedRule = H.scopedRule('db-check')
      .when({ partitions: ['db'] })
      .directive('Keep schema migrations additive.')
      .enforceBeforeStop(SampleCleanTreeCheckNode);
    const rulesNode = H.rules('repo-rules')
      .global({ id: 'g1', directive: 'Write deterministic tests.' })
      .scoped(scopedRule)
      .toAST();
    expect(rulesNode.globalRules.length).toBe(1);
    expect(rulesNode.scopedRules.length).toBe(1);

    const skillNode = H.skill('git-conflict-skill')
      .when({ partitions: ['db'] })
      .description('Resolve git rebase conflicts.')
      .instructions('Inspect conflict markers and run tests.')
      .unlocksTools(DeclaredToolNode)
      .lease('until-completed-or-fork-exit')
      .toAST();
    expect(skillNode.unlockedTools.length).toBe(1);

    const promoSignal = H.signal('promote-lesson').payload(z.object({ lessonId: z.string() }));
    const lessonsNode = H.lessons('empirical-lessons')
      .store(SampleLessonStoreNode)
      .queryFrom(
        z.object({ title: z.string().default('default-title') }),
        (input: { readonly title: string }) => input.title,
      )
      .distillWith(SampleModelNode, ($d: LessonDistillationBuilder) =>
        $d.onLoopRecovery().onGateRecovery({ minFailedChecks: 1 }).guidelines('Distill concisely.'),
      )
      .scoring(($s: LessonScoringBuilder) =>
        $s
          .slidingWindowInjections(20)
          .partitionMatchBoost(1.5)
          .decayOnPartitionEpochChange(0.5)
          .recall({ minScore: 0.25, maxItems: 5 }),
      )
      .retireAfter(($r: LessonRetirementBuilder) =>
        $r.maxViolations(2).orMinCleanPassRate(0.6, { afterInjections: 8 }),
      )
      .emitSignalWhen(
        promoSignal,
        ($t: LessonSignalTriggerBuilder) => $t.minCleanPasses(5).maxViolations(0).cooldownHours(24),
        (lesson: LessonRecord) => ({ lessonId: lesson.id }),
      )
      .toAST();
    expect(lessonsNode.scoring.slidingWindowInjections).toBe(20);
    expect(lessonsNode.emitSignalTriggers.length).toBe(1);

    const limitInterrupt = H.interrupt('limit-hit').payload(z.object({ reason: z.string() }));
    const basePolicy = H.policy<GitWorktreeHandle>('base-policy')
      .guard(SampleGuardNode)
      .onViolation('deny-with-error', (v: PolicyViolation) => `Blocked: ${v.violationSummary}`)
      .maxTurns(25)
      .maxCostUsd(5)
      .maxDurationSeconds(600)
      .onAbort(SampleAbortHookNode)
      .onLimitExceeded(($l: PolicyLimitExceededBuilder<GitWorktreeHandle>) =>
        $l.flushWithInterrupt(limitInterrupt).onAbort(SampleAbortHookNode),
      );
    const extendedPolicy = basePolicy
      .extend('extended-policy')
      .guard(SampleGuardNode)
      .onViolation(
        'raise-interrupt',
        limitInterrupt,
        (v: PolicyViolation) => ({ reason: v.violationSummary }),
      )
      .toAST();

    expect(basePolicy.toAST().clauses.length).toBe(1);
    expect(extendedPolicy.clauses.length).toBe(2);
    expect(extendedPolicy.clauses[0]?.id).toBe('extended-policy:clause:0');

    const humanBuilder = H.human('oncall-approver')
      .keepAliveSeconds(30)
      .notify(BidirectionalHumanChannelNode);
    const scopedHuman = humanBuilder
      .withName('budget-approver')
      .output(BudgetApprovalSchema)
      .toAST();
    expect(scopedHuman.alias).toBe('budget-approver');

    const cmdInputSchema = z.object({ count: z.number().default(1) });
    const cmdOutputSchema = z.object({ doubled: z.number() });
    const directCommand = H.command('direct-cmd', {
      input: cmdInputSchema,
      output: cmdOutputSchema,
      extractPartitions: () => ['db'],
      fn: async (
        input: { readonly count: number },
        _ctx: ExecutionContext<GitWorktreeHandle>,
      ) => ({ doubled: input.count * 2 }),
    }).toAST();

    const fluentCommand = H.command('fluent-cmd')
      .input(cmdInputSchema)
      .output(cmdOutputSchema)
      .partitions(() => ['api'])
      .run(
        async (
          input: { readonly count: number },
          _ctx: ExecutionContext<GitWorktreeHandle>,
        ) => ({ doubled: input.count * 2 }),
      )
      .toAST();

    expect(directCommand.type).toBe('harness:command');
    expect('execute' in directCommand).toBe(false);
    expect(fluentCommand.id).toBe('fluent-cmd');
  });
});

describe('H.agent, H.loop, canonical roleKey derivation, and createExecutorRegistry', () => {
  const actorInSchema = z.object({
    issueId: z.string(),
    partitions: z.array(z.string()).default(['db']),
  });
  const actorOutSchema = z.object({
    summary: z.string(),
    filesChanged: z.number().default(1),
  });
  const evalInSchema = z.object({
    summary: z.string(),
    scopeReceipt: SampleScopeReceiptSchema,
  });
  const evalOutSchema = z.object({
    passed: z.boolean(),
    feedback: z.string().default(''),
  });
  const escalateIntr = H.interrupt('escalate-intr').payload(z.object({ question: z.string() }));

  it('derives order-independent canonical roleKey on .withTools() and preserves .onInterrupt() on .withPolicy()', () => {
    const basePolicy = H.policy<GitWorktreeHandle>('actor-policy').maxTurns(10);
    const replacementPolicy = H.policy<GitWorktreeHandle>('replacement-policy').maxTurns(20);
    const human = H.human('reviewer').notify(BidirectionalHumanChannelNode);

    const baseCoder = H.agent<GitWorktreeHandle>('coder')
      .model(SampleModelNode)
      .policy(basePolicy)
      .tools(DeclaredToolNode)
      .input(actorInSchema)
      .partitions((input: { readonly issueId: string; readonly partitions: string[] }) =>
        input.partitions,
      )
      .output(actorOutSchema)
      .onInterrupt(escalateIntr, ($i) =>
        $i
          .ask(human, z.object({ answer: z.string() }))
          .resumeWith((d: { readonly answer: string }) => d.answer),
      );

    const cloneOrderA = baseCoder.withTools(ExtraSearchToolNode, ExtraCompareToolNode);
    const cloneOrderB = baseCoder.withTools(ExtraCompareToolNode, ExtraSearchToolNode);
    const policyClone = cloneOrderA.withPolicy(replacementPolicy).toAST();

    expect(baseCoder.roleKey).toBe('coder');
    expect(cloneOrderA.roleKey).toBe('coder+tools:ast_grep,git_compare');
    expect(cloneOrderB.roleKey).toBe('coder+tools:ast_grep,git_compare');
    expect(policyClone.policy?.id).toBe('replacement-policy');
    expect(policyClone.onInterruptHandlers.length).toBe(1);

    const evaluator = H.agent<GitWorktreeHandle>('evaluator')
      .model(SampleModelNode)
      .input(evalInSchema)
      .output(evalOutSchema);

    const refineLoop = H.loop<GitWorktreeHandle>('refine-loop')
      .input(actorInSchema)
      .output(actorOutSchema)
      .maxIterations(3)
      .preserveActorSession(true)
      .act('code', baseCoder)
      .evaluate('review', evaluator, {
        mapInput: (
          _loopIn: z.output<typeof actorInSchema>,
          actOut: z.output<typeof actorOutSchema>,
          receipt: GitScopeReceipt,
        ) => ({
          summary: actOut.summary,
          scopeReceipt: receipt,
        }),
        acceptWhen: (verdict: z.output<typeof evalOutSchema>) => verdict.passed,
        feedbackMapper: (verdict: z.output<typeof evalOutSchema>) => verdict.feedback,
      })
      .returnOutputFrom('code');

    const loopWithTools = refineLoop.withTools(ExtraCompareToolNode, ExtraSearchToolNode);
    const loopWithPolicy = loopWithTools.withPolicy(replacementPolicy).toAST();

    expect(loopWithTools.roleKey).toBe('coder+tools:ast_grep,git_compare');
    expect(loopWithPolicy.actStep.actor.policy?.id).toBe('replacement-policy');
    expect(loopWithPolicy.actStep.actor.onInterruptHandlers.length).toBe(1);
  });

  it('merges partial executor slices and supports nested slice arrays in createExecutorRegistry', () => {
    const checkFn = async () => ({ ok: true, deficits: [] });
    const overrideCheckFn = async () => ({ ok: false, deficits: ['dirty'] });
    const merged = createExecutorRegistry(
      { checks: { 'git:clean-working-tree': checkFn } },
      [
        {
          policyGuards: {
            'fs:protect': () => ({ allowed: true, violatedEffects: [], violationSummary: '' }),
          },
        },
        { checks: { 'git:clean-working-tree': overrideCheckFn } },
      ],
    );
    expect(Object.isFrozen(merged)).toBe(true);
    expect(merged.checks['git:clean-working-tree']).toBe(overrideCheckFn);
    expect(typeof merged.policyGuards['fs:protect']).toBe('function');
  });
});
