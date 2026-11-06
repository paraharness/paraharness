import { describe, expect, it } from 'vitest';
import {
  BudgetApprovalSchema, type ExecutionContext, type GitScopeReceipt, type GitWorktreeHandle, H,
  type InterruptBuilder, type LessonDistillationBuilder, type LessonRecord, type LessonRetirementBuilder,
  type LessonScoringBuilder, type LessonSignalTriggerBuilder, type MarkdownFrontmatterSourceNode,
  type PolicyLimitExceededBuilder, type PolicyViolation, type PoolCandidateState,
  type PoolSelectionContext, type PoolStrategyConfigurator, type ScopedRule, type SignalBuilder,
  type SkillNode, affectedBy, createExecutorRegistry, dependentsOf, z,
} from '../src/index.js';
import {
  SAMPLE_ABORT_HOOK_NODE, SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE, SAMPLE_CLEAN_TREE_CHECK_NODE,
  SAMPLE_DECLARED_TOOL_NODE, SAMPLE_EXTRA_COMPARE_TOOL_NODE, SAMPLE_EXTRA_SEARCH_TOOL_NODE,
  SAMPLE_GUARD_NODE, SAMPLE_LESSON_STORE_NODE, SAMPLE_MODEL_NODE, SAMPLE_SCOPE_RECEIPT_SCHEMA,
  SAMPLE_STREAM_SOURCE_NODE, SAMPLE_TOPOLOGY_STORE_NODE,
} from './fixtures/sample-domain-nodes.constants.js';

describe('H.topology DAG validation and graph queries', () => {
  const prMergedSignal = H.signal('pr-merged').payload(z.object({ runId: z.string(), prNumber: z.number() }));

  it('compiles a valid topology DAG and computes dependentsOf and affectedBy', () => {
    const repoTopology = H.topology('repo-contracts')
      .store(SAMPLE_TOPOLOGY_STORE_NODE)
      .partitions({
        db: { dependsOn: [] },
        api: { dependsOn: ['db'] },
        web: { dependsOn: ['api'] },
      })
      .commitOverlayWhen({
        onSignal: {
          signal: prMergedSignal,
          correlateBy: (payload: { readonly runId: string; readonly prNumber: number }) => payload.runId,
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
      H.topology('unknown-dep').store(SAMPLE_TOPOLOGY_STORE_NODE).partitions<string>({ db: { dependsOn: ['missing'] } }),
    ).toThrowError("Topology 'unknown-dep' partition 'db' depends on unknown partition 'missing'.");

    expect(() =>
      H.topology('self-cycle').store(SAMPLE_TOPOLOGY_STORE_NODE).partitions({ db: { dependsOn: ['db'] } }),
    ).toThrowError("Topology 'self-cycle' contains a self-dependency cycle on partition 'db' (db -> db).");

    expect(() =>
      H.topology('multi-cycle')
        .store(SAMPLE_TOPOLOGY_STORE_NODE)
        .partitions({ db: { dependsOn: ['web'] }, api: { dependsOn: ['db'] }, web: { dependsOn: ['api'] } }),
    ).toThrowError("Topology 'multi-cycle' contains a dependency cycle: db -> web -> api -> db.");
  });
});

describe('Primitive and context builders (signal, interrupt, stream, pool, prefixGroup, rules, skill, lessons, policy, human, command)', () => {
  it('maintains copy-on-write immutability and deep-freeze across signal, interrupt, stream, and pool builders', () => {
    const defaultPayloadSchema = z.object({ ok: z.boolean().default(true) });
    const directSignal: SignalBuilder<{ readonly ok: boolean }> = H.signal('sig-default', defaultPayloadSchema);
    const directInterrupt: InterruptBuilder<{ readonly ok: boolean }> = H.interrupt('intr-default', defaultPayloadSchema);
    expect(directSignal.toAST().schema.parse({})).toEqual({ ok: true });
    expect(directInterrupt.toAST().schema.parse({})).toEqual({ ok: true });

    const baseSignal = H.signal('base-sig');
    const typedSignal = baseSignal.payload(defaultPayloadSchema);
    expect(baseSignal.toAST()).not.toBe(typedSignal.toAST());
    expect(typedSignal.id).toBe('base-sig');
    expect(typedSignal.type).toBe('harness:signal');

    const streamNode = H.stream('gh-webhooks')
      .source(SAMPLE_STREAM_SOURCE_NODE)
      .filter((ev: { readonly prNumber: number; readonly merged: boolean }) => ev.merged)
      .emitSignal(typedSignal, (ev: { readonly prNumber: number; readonly merged: boolean }) => ({ ok: ev.prNumber > 0 }))
      .toAST();
    expect(streamNode.type).toBe('harness:stream');
    expect(streamNode.signal.id).toBe('base-sig');
    expect(Object.isFrozen(streamNode)).toBe(true);

    const customSelector = (
      candidates: readonly PoolCandidateState<typeof SAMPLE_MODEL_NODE>[],
      _ctx: PoolSelectionContext,
    ): typeof SAMPLE_MODEL_NODE | undefined => candidates[0]?.item;
    const oneArgSelector = (
      candidates: readonly PoolCandidateState<typeof SAMPLE_MODEL_NODE>[],
    ): typeof SAMPLE_MODEL_NODE | undefined =>
      candidates.find((c) => c.rateLimitedUntilMs === undefined)?.item;

    const poolSoonest = H.pool('models-soonest').with(SAMPLE_MODEL_NODE).strategy('soonest-reset').fallback(SAMPLE_MODEL_NODE).toAST();
    const poolRoundRobin = H.pool('models-rr').with(SAMPLE_MODEL_NODE).strategy('round-robin').toAST();
    const poolLeastUsed = H.pool('models-lu').with(SAMPLE_MODEL_NODE).strategy('least-used').toAST();
    const poolEscalate = H.pool('models-esc')
      .with(SAMPLE_MODEL_NODE)
      .strategy(($s: PoolStrategyConfigurator<typeof SAMPLE_MODEL_NODE>) => $s.escalateOnRetry().minSuccessRate(0.8).minSamples(5))
      .toAST();
    const poolCustom = H.pool('models-custom').with(SAMPLE_MODEL_NODE).strategy(customSelector).toAST();
    const poolOneArgCustom = H.pool('models-one-arg').with(SAMPLE_MODEL_NODE).strategy(oneArgSelector).toAST();

    expect(poolSoonest.strategy.strategyKind).toBe('soonest-reset');
    expect(poolRoundRobin.strategy.strategyKind).toBe('round-robin');
    expect(poolLeastUsed.strategy.strategyKind).toBe('least-used');
    expect(poolEscalate.strategy.strategyKind).toBe('escalate-on-retry');
    expect(poolCustom.strategy.strategyKind).toBe('custom');
    expect(poolOneArgCustom.strategy.strategyKind).toBe('custom');
    if (poolOneArgCustom.strategy.strategyKind !== 'custom') {
      throw new Error('Expected custom strategyKind');
    }
    expect(
      poolOneArgCustom.strategy.selectFn(
        [{ item: SAMPLE_MODEL_NODE, index: 0, id: 'opus', usageCount: 0, successCount: 0, sampleCount: 0, empiricalSuccessRate: 1 }],
        { poolId: 'models-one-arg', runId: 'r1', retryAttempt: 0, nowMs: 1000 },
      ),
    ).toBe(SAMPLE_MODEL_NODE);
  });

  it('builds prefixGroup, rules, scopedRule, skill, lessons, policy (.extend), human, and command AST nodes including sourced rules/skills', () => {
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
      .enforceBeforeStop(SAMPLE_CLEAN_TREE_CHECK_NODE);
    const mdRuleSource: MarkdownFrontmatterSourceNode<ScopedRule> = {
      type: 'markdown:frontmatter',
      id: 'md-db-rule',
      pathOrGlob: '.harness/rules/db.md',
    };
    const sourcedScopedRule = H.scopedRule(mdRuleSource).enforceBeforeStop(SAMPLE_CLEAN_TREE_CHECK_NODE).toAST();
    expect(sourcedScopedRule.id).toBe('.harness/rules/db.md');

    const rulesNode = H.rules('repo-rules')
      .global({ id: 'g1', directive: 'Write deterministic tests.' })
      .scoped(scopedRule, sourcedScopedRule)
      .toAST();
    expect(rulesNode.globalRules.length).toBe(1);
    expect(rulesNode.scopedRules.length).toBe(2);

    const skillNode = H.skill('git-conflict-skill')
      .when({ partitions: ['db'] })
      .description('Resolve git rebase conflicts.')
      .instructions('Inspect conflict markers and run tests.')
      .unlocksTools(SAMPLE_DECLARED_TOOL_NODE)
      .lease('until-completed-or-fork-exit')
      .toAST();
    expect(skillNode.unlockedTools.length).toBe(1);

    const mdSkillSource: MarkdownFrontmatterSourceNode<SkillNode<GitWorktreeHandle>> = {
      type: 'markdown:frontmatter',
      id: 'md-git-skill',
      pathOrGlob: '.harness/skills/git/SKILL.md',
    };
    const sourcedSkillNode = H.skill(mdSkillSource).unlocksTools(SAMPLE_DECLARED_TOOL_NODE).toAST();
    expect(sourcedSkillNode.id).toBe('.harness/skills/git/SKILL.md');

    const promoSignal = H.signal('promote-lesson').payload(z.object({ lessonId: z.string() }));
    const lessonsNode = H.lessons('empirical-lessons')
      .store(SAMPLE_LESSON_STORE_NODE)
      .queryFrom(
        z.object({ title: z.string().default('default-title') }),
        (input: { readonly title: string }) => input.title,
      )
      .distillWith(SAMPLE_MODEL_NODE, ($d: LessonDistillationBuilder) =>
        $d.onLoopRecovery().onGateRecovery({ minFailedChecks: 1 }).guidelines('Distill concisely.'),
      )
      .scoring(($s: LessonScoringBuilder) =>
        $s.slidingWindowInjections(20).partitionMatchBoost(1.5).decayOnPartitionEpochChange(0.5).recall({ minScore: 0.25, maxItems: 5 }),
      )
      .retireAfter(($r: LessonRetirementBuilder) => $r.maxViolations(2).orMinCleanPassRate(0.6, { afterInjections: 8 }))
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
      .guard(SAMPLE_GUARD_NODE)
      .onViolation('deny-with-error', (v: PolicyViolation) => `Blocked: ${v.violationSummary}`)
      .maxTurns(25)
      .maxCostUsd(5)
      .maxDurationSeconds(600)
      .onAbort(SAMPLE_ABORT_HOOK_NODE)
      .onLimitExceeded(($l: PolicyLimitExceededBuilder<GitWorktreeHandle>) =>
        $l.flushWithInterrupt(limitInterrupt).onAbort(SAMPLE_ABORT_HOOK_NODE),
      );
    const extendedPolicy = basePolicy
      .extend('extended-policy')
      .guard(SAMPLE_GUARD_NODE)
      .onViolation('raise-interrupt', limitInterrupt, (v: PolicyViolation) => ({ reason: v.violationSummary }))
      .toAST();

    expect(basePolicy.toAST().clauses.length).toBe(1);
    expect(extendedPolicy.clauses.length).toBe(2);
    expect(extendedPolicy.clauses[0]?.id).toBe('extended-policy:clause:0');

    const humanBuilder = H.human('oncall-approver').keepAliveSeconds(30).notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE);
    const scopedHuman = humanBuilder.withName('budget-approver').output(BudgetApprovalSchema).toAST();
    expect(scopedHuman.alias).toBe('budget-approver');

    const cmdInputSchema = z.object({ count: z.number().default(1) });
    const cmdOutputSchema = z.object({ doubled: z.number() });
    const directCommand = H.command('direct-cmd', {
      input: cmdInputSchema,
      output: cmdOutputSchema,
      extractPartitions: () => ['db'],
      fn: async (input: { readonly count: number }, _ctx: ExecutionContext<GitWorktreeHandle>) => ({ doubled: input.count * 2 }),
    }).toAST();

    const fluentCommand = H.command('fluent-cmd')
      .input(cmdInputSchema)
      .output(cmdOutputSchema)
      .partitions(() => ['api'])
      .run(async (input: { readonly count: number }, _ctx: ExecutionContext<GitWorktreeHandle>) => ({ doubled: input.count * 2 }))
      .toAST();

    expect(directCommand.type).toBe('harness:command');
    expect('execute' in directCommand).toBe(false);
    expect(fluentCommand.id).toBe('fluent-cmd');
  });
});

describe('H.agent, H.loop, canonical roleKey derivation, and createExecutorRegistry', () => {
  const actorInSchema = z.object({ issueId: z.string(), partitions: z.array(z.string()).default(['db']) });
  const actorOutSchema = z.object({ summary: z.string(), filesChanged: z.number().default(1) });
  const evalInSchema = z.object({ summary: z.string(), scopeReceipt: SAMPLE_SCOPE_RECEIPT_SCHEMA });
  const evalOutSchema = z.object({ passed: z.boolean(), feedback: z.string().default('') });
  const escalateIntr = H.interrupt('escalate-intr').payload(z.object({ question: z.string() }));

  it('derives order-independent canonical roleKey on .withTools(), preserves .onInterrupt() on .withPolicy(), and validates canSpawnTasks bounds', () => {
    const basePolicy = H.policy<GitWorktreeHandle>('actor-policy').maxTurns(10);
    const replacementPolicy = H.policy<GitWorktreeHandle>('replacement-policy').maxTurns(20);
    const human = H.human('reviewer').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE);

    const baseCoder = H.agent<GitWorktreeHandle>('coder')
      .model(SAMPLE_MODEL_NODE)
      .policy(basePolicy)
      .tools(SAMPLE_DECLARED_TOOL_NODE)
      .input(actorInSchema)
      .partitions((input: { readonly issueId: string; readonly partitions: string[] }) => input.partitions)
      .output(actorOutSchema)
      .onInterrupt(escalateIntr, ($i) => $i.ask(human, z.object({ answer: z.string() })).resumeWith((d: { readonly answer: string }) => d.answer));

    expect(() =>
      baseCoder.capabilities(($c) => $c.mutatePlan(($m) => $m.canSpawnTasks(actorInSchema, { maxSpawnedPerRun: 0 }))),
    ).toThrowError('$cap.mutatePlan.canSpawnTasks(maxSpawnedPerRun) requires a positive integer >= 1 (received 0).');

    expect(() =>
      baseCoder.capabilities(($c) =>
        $c.mutatePlan(($m) => $m.canSpawnTasks(actorInSchema, { maxSpawnedPerRun: 2, maxPrerequisiteDepth: 0 })),
      ),
    ).toThrowError('$cap.mutatePlan.canSpawnTasks(maxPrerequisiteDepth) requires a positive integer >= 1 (received 0).');

    const cloneOrderA = baseCoder.withTools(SAMPLE_EXTRA_SEARCH_TOOL_NODE, SAMPLE_EXTRA_COMPARE_TOOL_NODE);
    const cloneOrderB = baseCoder.withTools(SAMPLE_EXTRA_COMPARE_TOOL_NODE, SAMPLE_EXTRA_SEARCH_TOOL_NODE);
    const policyClone = cloneOrderA.withPolicy(replacementPolicy).toAST();

    expect(baseCoder.roleKey).toBe('coder');
    expect(cloneOrderA.roleKey).toBe('coder+tools:ast_grep,git_compare');
    expect(cloneOrderB.roleKey).toBe('coder+tools:ast_grep,git_compare');
    expect(policyClone.policy?.id).toBe('replacement-policy');
    expect(policyClone.onInterruptHandlers.length).toBe(1);

    const evaluator = H.agent<GitWorktreeHandle>('evaluator').model(SAMPLE_MODEL_NODE).input(evalInSchema).output(evalOutSchema);
    const refineLoop = H.loop<GitWorktreeHandle>('refine-loop')
      .input(actorInSchema)
      .output(actorOutSchema)
      .maxIterations(3)
      .preserveActorSession(true)
      .act('code', baseCoder)
      .evaluate('review', evaluator, {
        mapInput: (_loopIn: z.output<typeof actorInSchema>, actOut: z.output<typeof actorOutSchema>, receipt: GitScopeReceipt) => ({
          summary: actOut.summary,
          scopeReceipt: receipt,
        }),
        acceptWhen: (verdict: z.output<typeof evalOutSchema>) => verdict.passed,
        feedbackMapper: (verdict: z.output<typeof evalOutSchema>) => verdict.feedback,
      })
      .returnOutputFrom('code');

    const loopWithTools = refineLoop.withTools(SAMPLE_EXTRA_COMPARE_TOOL_NODE, SAMPLE_EXTRA_SEARCH_TOOL_NODE);
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
        { policyGuards: { 'fs:protect': () => ({ allowed: true, violatedEffects: [], violationSummary: '' }) } },
        { checks: { 'git:clean-working-tree': overrideCheckFn } },
      ],
    );
    expect(Object.isFrozen(merged)).toBe(true);
    expect(merged.checks['git:clean-working-tree']).toBe(overrideCheckFn);
    expect(typeof merged.policyGuards['fs:protect']).toBe('function');
  });
});
