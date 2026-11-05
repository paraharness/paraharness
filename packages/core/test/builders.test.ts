import { describe, expect, it } from 'vitest';
import {
  AbortHook,
  AccountSeatDescriptor,
  BranchableScope,
  BudgetApprovalSchema,
  CheckpointableScope,
  ControlPlaneAdapter,
  createHarnessRuntime,
  CrossVerifier,
  DistilledLessonCandidateSchema,
  EffectMatcher,
  ExecutionContext,
  FlowBranchNodeConfig,
  FlowStepNodeConfig,
  GlobalRuleSchema,
  H,
  HumanAdapter,
  IsolationScope,
  LeaseDelta,
  LedgerStore,
  LessonStore,
  PolicyGuard,
  PoolCandidateState,
  PoolSelectorFn,
  PoolStrategyPort,
  QuotaTripwire,
  registerStepExecutors,
  ResumeForkInputSchema,
  ScopedRuleSchema,
  ScopeRewindHook,
  Service,
  SkillDefinitionSchema,
  SpeculationCandidateSchema,
  SpeculationInputSchema,
  StreamSource,
  TelemetryCollector,
  ToolDefinition,
  TopologyStore,
  TrackerAdapter,
  z,
  zodToJsonSchema,
} from '../src/index.js';

function createDummyExecutionContext<THandle>(scopeHandle: THandle): ExecutionContext<THandle> {
  return {
    runId: 'run-1',
    stepExecId: 'step-exec-1',
    scopeHandle,
    activePartitions: ['db'],
    activeLeases: [],
    recordEffects() {},
  };
}

function createTier1Scope(): IsolationScope<{ readonly sessionId: string }, { readonly journalEntryId: string }> {
  return {
    kind: 'harness:isolation-scope',
    id: 'tier1-scope',
    receiptSchema: z.object({ journalEntryId: z.string() }),
    async acquireRoot(runId) {
      return { sessionId: `root-${runId}` };
    },
    async reattachRoot(runId) {
      return { sessionId: `reattach-${runId}` };
    },
    async inspect(handle) {
      return { journalEntryId: `journal-${handle.sessionId}` };
    },
    async release() {},
  };
}

function createTier2Scope(): CheckpointableScope<
  { readonly worktreePath: string },
  { readonly headSha: string }
> {
  return {
    kind: 'harness:isolation-scope',
    id: 'tier2-scope',
    supportsCheckpoints: true,
    receiptSchema: z.object({ headSha: z.string() }),
    async acquireRoot(runId) {
      return { worktreePath: `/tmp/roots/${runId}` };
    },
    async reattachRoot(runId) {
      return { worktreePath: `/tmp/roots/${runId}` };
    },
    async inspect() {
      return { headSha: 'abc1234' };
    },
    async release() {},
    async serializeCheckpoint() {
      return 'ckpt-1';
    },
    async restoreCheckpoint() {},
    async diffEffects() {
      return [];
    },
  };
}

function createTier3Scope(): BranchableScope<
  { readonly worktreePath: string },
  { readonly headRef: string; readonly diffStat: string },
  { readonly baseSha: string }
> &
  CheckpointableScope<
    { readonly worktreePath: string },
    { readonly headRef: string; readonly diffStat: string }
  > {
  return {
    kind: 'harness:isolation-scope',
    id: 'tier3-scope',
    supportsCheckpoints: true,
    supportsBranching: true,
    receiptSchema: z.object({ headRef: z.string(), diffStat: z.string() }),
    syncSchema: z.object({ baseSha: z.string() }),
    async acquireRoot(runId) {
      return { worktreePath: `/tmp/roots/${runId}` };
    },
    async reattachRoot(runId) {
      return { worktreePath: `/tmp/roots/${runId}` };
    },
    async inspect() {
      return { headRef: 'refs/heads/fix/1', diffStat: '1 file changed' };
    },
    async release() {},
    async serializeCheckpoint() {
      return 'ckpt-1';
    },
    async restoreCheckpoint() {},
    async diffEffects() {
      return [];
    },
    async forkChild(_parent, forkId) {
      return { worktreePath: `/tmp/forks/${forkId}` };
    },
    async reattachChild(_parent, forkId) {
      return { worktreePath: `/tmp/forks/${forkId}` };
    },
    async commitChild() {
      return {
        status: 'clean',
        data: { headRef: 'refs/heads/fix/1', diffStat: '1 file changed' },
      };
    },
    async syncChild() {
      return {
        status: 'clean',
        data: { baseSha: 'def5678' },
      };
    },
    async syncRoot() {
      return {
        status: 'clean',
        data: { baseSha: 'def5678' },
      };
    },
  };
}

describe('M1 @harness-dsl/core Contracts, Schemas, AST & Fluent Builders', () => {
  describe('1. H.topology DAG, Cycle Detection & Signal-Correlated Overlays', () => {
    it('computes transitive dependentsOf and affectedBy on linear and diamond graphs', () => {
      const shippedSignal = H.signal('change-shipped').payload(
        z.object({ ref: z.string(), baseBranch: z.string() }),
      );
      const closedSignal = H.signal('pr-closed').payload(z.object({ ref: z.string() }));

      const linearTopology = H.topology('app-topology')
        .partitions({
          db: {},
          api: { dependsOn: ['db'] },
          web: { dependsOn: ['api'] },
        })
        .commitOverlayWhen({
          onSignal: {
            signal: shippedSignal,
            correlateBy: (sig) => sig.ref,
            baseBranch: (sig) => sig.baseBranch,
          },
          discardOnSignal: {
            signal: closedSignal,
            correlateBy: (sig) => sig.ref,
          },
          maxSealedAgeHours: 168,
        });

      expect(linearTopology.kind).toBe('harness:topology');
      expect(linearTopology.id).toBe('app-topology');
      expect(linearTopology.dependentsOf('db')).toEqual(['api', 'web']);
      expect(linearTopology.affectedBy('db')).toEqual(['db', 'api', 'web']);
      expect(linearTopology.dependentsOf('api')).toEqual(['web']);
      expect(linearTopology.affectedBy('api')).toEqual(['api', 'web']);
      expect(linearTopology.dependentsOf('web')).toEqual([]);
      expect(linearTopology.affectedBy('web')).toEqual(['web']);
      expect(linearTopology.overlayOptions?.maxSealedAgeHours).toBe(168);
      expect(
        linearTopology.overlayOptions?.onSignal?.correlateBy({
          ref: '#101',
          baseBranch: 'main',
        }),
      ).toBe('#101');
      expect(
        linearTopology.overlayOptions?.onSignal?.baseBranch?.({
          ref: '#101',
          baseBranch: 'fix/#100',
        }),
      ).toBe('fix/#100');
      expect(linearTopology.overlayOptions?.discardOnSignal?.correlateBy({ ref: '#102' })).toBe(
        '#102',
      );

      const diamondTopology = H.topology('diamond-topology').partitions({
        core: {},
        db: { dependsOn: ['core'] },
        auth: { dependsOn: ['core'] },
        api: { dependsOn: ['db', 'auth'] },
        ui: { dependsOn: ['api', 'auth'] },
      });

      expect(diamondTopology.dependentsOf('core')).toEqual(['db', 'auth', 'api', 'ui']);
      expect(diamondTopology.affectedBy('core')).toEqual(['core', 'db', 'auth', 'api', 'ui']);
      expect(diamondTopology.dependentsOf('auth')).toEqual(['api', 'ui']);
      expect(diamondTopology.affectedBy('db')).toEqual(['db', 'api', 'ui']);
    });

    it('throws at build time on cycles, self-loops, or unknown partition references', () => {
      expect(() =>
        H.topology('cyclic-3').partitions({
          db: { dependsOn: ['web'] },
          api: { dependsOn: ['db'] },
          web: { dependsOn: ['api'] },
        }),
      ).toThrow(/Cycle detected in topology 'cyclic-3'/);

      expect(() =>
        H.topology('self-loop').partitions({
          db: { dependsOn: ['db'] },
        }),
      ).toThrow(/Cycle detected in topology 'self-loop'/);

      expect(() =>
        H.topology('missing-dep').partitions({
          api: { dependsOn: ['nonexistent'] },
        }),
      ).toThrow(/depends on unknown partition 'nonexistent'/);
    });
  });

  describe('2. H.pool Presets, escalateOnRetry & Custom Selection Strategies', () => {
    it('compiles preset strategies, escalateOnRetry builder chains, $.custom, PoolStrategyPort, and PoolSelectorFn', () => {
      const seatA: AccountSeatDescriptor = { kind: 'claude:account-seat', id: 'seat-a' };
      const seatB: AccountSeatDescriptor = { kind: 'openai:account-seat', id: 'seat-b' };
      const fallbackSeat: AccountSeatDescriptor = { kind: 'gemini:account-seat', id: 'seat-fallback' };

      const soonestPool = H.pool('accounts-soonest')
        .with(seatA, seatB)
        .strategy('soonest-reset')
        .fallback(fallbackSeat);

      expect(soonestPool.kind).toBe('harness:pool');
      expect(soonestPool.items).toEqual([seatA, seatB]);
      expect(soonestPool.strategyConfig).toEqual({ mode: 'soonest-reset' });
      expect(soonestPool.fallbackItem).toEqual(fallbackSeat);

      const rrPool = soonestPool.strategy('round-robin');
      expect(rrPool.strategyConfig).toEqual({ mode: 'round-robin' });

      const leastUsedPool = soonestPool.strategy('least-used');
      expect(leastUsedPool.strategyConfig).toEqual({ mode: 'least-used' });

      const escalatePool = H.pool('models-escalate')
        .with('sonnet', 'opus')
        .strategy(($) => $.escalateOnRetry().minSuccessRate(0.8).minSamples(5));

      expect(escalatePool.strategyConfig).toEqual({
        mode: 'escalate-on-retry',
        minSuccessRate: 0.8,
        minSamples: 5,
        customStrategy: undefined,
      });

      const builderCustomPool = H.pool('models-builder-custom')
        .with('sonnet', 'opus')
        .strategy(($) =>
          $.custom((candidates: readonly PoolCandidateState<string>[]) =>
            candidates.find((c) => c.usageCount === 0)?.item,
          ),
        );

      expect(builderCustomPool.strategyConfig.mode).toBe('custom');
      expect(typeof builderCustomPool.strategyConfig.customStrategy).toBe('function');

      const strategyPort: PoolStrategyPort<string> = {
        kind: 'harness:pool-strategy',
        id: 'lowest-usage-port',
        select(candidates, ctx) {
          const sticky = candidates.find((c) => c.id === ctx.stickyCandidateId);
          return (sticky ?? candidates[0])?.item;
        },
      };

      const portPool = H.pool('models-port')
        .with('sonnet', 'opus')
        .strategy(strategyPort);

      expect(portPool.strategyConfig).toEqual({
        mode: 'custom',
        customStrategy: strategyPort,
      });

      const builderPortPool = H.pool('models-builder-port')
        .with('sonnet', 'opus')
        .strategy(($) => $.custom(strategyPort));

      expect(builderPortPool.strategyConfig).toEqual({
        mode: 'custom',
        minSuccessRate: undefined,
        minSamples: undefined,
        customStrategy: strategyPort,
      });

      const directSelector: PoolSelectorFn<string> = (candidates, ctx) =>
        candidates[ctx.retryAttempt]?.item ?? candidates[0]?.item;

      const directFnPool = H.pool('models-direct-fn')
        .with('sonnet', 'opus')
        .strategy(directSelector);

      expect(directFnPool.strategyConfig.mode).toBe('custom');
      expect(typeof directFnPool.strategyConfig.customStrategy).toBe('function');
      if (typeof directFnPool.strategyConfig.customStrategy === 'function') {
        const picked = directFnPool.strategyConfig.customStrategy(
          [
            {
              item: 'sonnet',
              index: 0,
              id: 'sonnet',
              usageCount: 1,
              successCount: 1,
              sampleCount: 1,
              empiricalSuccessRate: 1,
            },
            {
              item: 'opus',
              index: 1,
              id: 'opus',
              usageCount: 0,
              successCount: 1,
              sampleCount: 1,
              empiricalSuccessRate: 1,
            },
          ],
          { poolId: 'models-direct-fn', runId: 'r1', retryAttempt: 1, nowMs: 1000 },
        );
        expect(picked).toBe('opus');
      }
    });
  });

  describe('3. H.policy Chaining & .extend() Inheritance', () => {
    it('preserves chained guard clauses in declaration order and inherits clauses and abortHook across .extend()', () => {
      const boundaryGuard: PolicyGuard = {
        kind: 'harness:policy-guard',
        id: 'boundary-guard',
        evaluate() {
          return { allowed: false, violatedEffects: [], violationSummary: 'Boundary write denied' };
        },
      };
      const testGuard: PolicyGuard = {
        kind: 'harness:policy-guard',
        id: 'test-guard',
        evaluate() {
          return {
            allowed: false,
            violatedEffects: [{ kind: 'fs:effect', mutatesScope: true, attributes: { paths: ['a.test.ts'] } }],
            violationSummary: 'Test write requires lease',
          };
        },
      };
      const maxFilesTripwire: QuotaTripwire = {
        kind: 'harness:quota-tripwire',
        id: 'max-files-4',
        onToolEffects(_acc, next) {
          return { tripped: next.length > 4, reason: 'Exceeded 4 files' };
        },
      };
      const snapshotAbortHook: AbortHook<{ readonly worktreePath: string }, { readonly abortedRef: string }> = {
        kind: 'harness:abort-hook',
        id: 'snapshot-reset',
        metaSchema: z.object({ abortedRef: z.string() }),
        async execute(_handle, runId) {
          return { abortedRef: `refs/harness/aborted/${runId}` };
        },
      };
      const leaseRequest = H.interrupt('lease-request').payload(
        z.object({ requestedPaths: z.array(z.string()), justification: z.string() }),
      );
      const scopeTripwire = H.interrupt('scope-exceeded').payload(
        z.object({ reason: z.string() }),
      );

      const workerBasePolicy = H.policy('worker-base')
        .guard(boundaryGuard)
        .onViolation('deny-with-error', (v) => `${v.violationSummary}: raise contract-violation`)
        .guard(testGuard)
        .onViolation('raise-interrupt', leaseRequest, (v) => ({
          requestedPaths: v.violatedEffects.flatMap(
            (e) => (e.attributes?.paths as string[] | undefined) ?? [],
          ),
          justification: v.violationSummary,
        }))
        .onAbort(snapshotAbortHook);

      expect(workerBasePolicy.guardClauses).toHaveLength(2);
      expect(workerBasePolicy.guardClauses[0]?.mode).toBe('deny-with-error');
      expect(
        workerBasePolicy.guardClauses[0]?.messageMapper?.({
          blockedCalls: [],
          violatedEffects: [],
          violationSummary: 'Denied',
        }),
      ).toBe('Denied: raise contract-violation');
      expect(workerBasePolicy.guardClauses[1]?.mode).toBe('raise-interrupt');
      expect(workerBasePolicy.guardClauses[1]?.interrupt).toBe(leaseRequest);
      expect(
        workerBasePolicy.guardClauses[1]?.interruptMapper?.({
          blockedCalls: [],
          violatedEffects: [{ kind: 'fs:effect', attributes: { paths: ['src/app.test.ts'] } }],
          violationSummary: 'Locked test file',
        }),
      ).toEqual({
        requestedPaths: ['src/app.test.ts'],
        justification: 'Locked test file',
      });
      expect(workerBasePolicy.abortHook).toBe(snapshotAbortHook);

      const fastPathPolicy = workerBasePolicy
        .extend('fast-path-limits')
        .tripwire(maxFilesTripwire)
        .maxTurns(8)
        .maxCostUsd(1.0)
        .maxDurationSeconds(300)
        .onLimitExceeded(($l) =>
          $l.flushWithInterrupt(scopeTripwire).onAbort(snapshotAbortHook),
        );

      expect(fastPathPolicy.id).toBe('fast-path-limits');
      expect(fastPathPolicy.guardClauses).toEqual(workerBasePolicy.guardClauses);
      expect(fastPathPolicy.abortHook).toBe(snapshotAbortHook);
      expect(fastPathPolicy.tripwires).toEqual([maxFilesTripwire]);
      expect(fastPathPolicy.maxTurnsLimit).toBe(8);
      expect(fastPathPolicy.maxCostUsdLimit).toBe(1.0);
      expect(fastPathPolicy.maxDurationSecondsLimit).toBe(300);
      expect(fastPathPolicy.limitExceededConfig).toEqual({
        flushInterrupt: scopeTripwire,
        abortHook: snapshotAbortHook,
      });

      expect(workerBasePolicy.tripwires).toEqual([]);
      expect(workerBasePolicy.maxTurnsLimit).toBeUndefined();
      expect(workerBasePolicy.limitExceededConfig).toBeUndefined();
    });
  });

  describe('4. H.agent & H.loop Clones (.withPolicy / .withTools) & registerStepExecutors', () => {
    it('computes deterministic roleKeys, preserves actor metadata across clones, and delegates execute() to registerStepExecutors', async () => {
      const workItemSchema = z.object({
        ref: z.string(),
        targetPartitions: z.array(z.enum(['db', 'api', 'web'])).default([]),
      });
      const workReceiptSchema = z.object({ summary: z.string() });
      const evalResultSchema = z.object({ accepted: z.boolean(), deficits: z.array(z.string()).default([]) });

      const leaseRequest = H.interrupt('lease-request').payload(
        z.object({ requestedPaths: z.array(z.string()) }),
      );
      const normativeEscalation = H.interrupt('normative-escalation').payload(
        z.object({ question: z.string() }),
      );

      const check = H.check('verify-check', async () => ({ ok: true, deficits: [] }));
      const dbEffectMatcher: EffectMatcher = {
        kind: 'harness:effect-matcher',
        id: 'db-write-matcher',
        matches: (eff) => eff.kind === 'fs:write',
      };
      const scopedRule = H.scopedRule('db-rule')
        .when({ partitions: ['db'], effects: dbEffectMatcher })
        .directive('Run migrations')
        .enforceBeforeStop(check);
      expect(scopedRule.idOrSource).toBe('db-rule');
      expect(scopedRule.predicate).toEqual({ partitions: ['db'], effects: dbEffectMatcher });
      expect(scopedRule.directiveSource).toBe('Run migrations');
      expect(scopedRule.beforeStopChecks).toEqual([check]);

      const rules = H.rules('rules').global({ id: 'g1', directive: 'No any' }).scoped(scopedRule);
      expect(rules.globalSources).toEqual([{ id: 'g1', directive: 'No any' }]);
      expect(rules.scopedEntries).toEqual([scopedRule]);

      const prefixGroup = H.prefixGroup('eng-prefix')
        .toolsMode('role-scoped')
        .sharedGrounding('ARCH.md')
        .sharedInstructions('Follow conventions')
        .sharedRules(rules);
      expect(prefixGroup.groundingSources).toEqual(['ARCH.md']);
      expect(prefixGroup.instructionSources).toEqual(['Follow conventions']);
      expect(prefixGroup.sharedRulesDef).toBe(rules);

      const topoStore: TopologyStore = {
        kind: 'harness:topology-store',
        async getPartitions() {
          return new Map();
        },
        async updateContract() {
          return { newEpoch: 1 };
        },
        async syncRunOverlays() {},
        async resetRunOverlay() {},
        async sealRunOverlay() {},
        async commitRunOverlay() {
          return { committedRunIds: [], updatedEpochs: new Map() };
        },
        async discardRunOverlay() {},
      };
      const topology = H.topology('topo')
        .store(topoStore)
        .partitions({ db: {}, api: { dependsOn: ['db'] }, web: {} });
      expect(topology.topologyStore).toBe(topoStore);

      const lessons = H.lessons('lessons').queryFrom(workItemSchema, (i) => i.ref);

      const devServer: Service = {
        kind: 'harness:service',
        id: 'dev-server',
        lifecycle: 'skill',
        toolSchemas: [],
        async acquire() {
          return { id: 'sess-1', tools: [], async stop() {} };
        },
      };
      const skill = H.skill('ui-skill')
        .when({ partitions: ['web'], effects: dbEffectMatcher })
        .description('UI verification')
        .instructions('Verify UI layout')
        .unlocksServices(devServer)
        .lease('until-completed-or-fork-exit');
      expect(skill.predicate).toEqual({ partitions: ['web'], effects: dbEffectMatcher });
      expect(skill.descriptionText).toBe('UI verification');
      expect(skill.instructionSource).toBe('Verify UI layout');
      expect(skill.unlockedServices).toEqual([devServer]);
      expect(skill.leaseMode).toBe('until-completed-or-fork-exit');

      const baseTool: ToolDefinition = {
        kind: 'harness:tool',
        name: 'read_file',
        description: 'Read a file',
        inputSchema: z.object({ path: z.string() }),
        describeEffects: () => [{ kind: 'fs:read', mutatesScope: false }],
        async execute() {
          return { content: 'ok' };
        },
      };
      const extraToolA: ToolDefinition = {
        kind: 'harness:tool',
        name: 'diff_candidates',
        description: 'Diff candidates',
        inputSchema: z.object({}),
        describeEffects: () => [],
        async execute() {
          return { content: 'diff' };
        },
      };
      const extraToolB: ToolDefinition = {
        kind: 'harness:tool',
        name: 'eval_in_candidates',
        description: 'Eval in candidates',
        inputSchema: z.object({}),
        describeEffects: () => [],
        async execute() {
          return { content: 'eval' };
        },
      };

      const owner = H.human('owner').keepAliveSeconds(60);
      const leaseDelta: LeaseDelta = {
        kind: 'harness:lease-delta',
        id: 'lease-1',
        grantedMatchers: [],
      };
      const adjudicator = H.agent('adjudicator')
        .input(z.object({ item: workItemSchema, req: leaseRequest.schema }))
        .output(z.object({ approved: z.boolean(), ruling: z.string() }));

      const basePolicy = H.policy('base-policy').maxTurns(5);
      const fastPolicy = basePolicy.extend('fast-policy').maxTurns(2);

      const worker = H.agent('worker')
        .prefixGroup(prefixGroup)
        .model('sonnet')
        .topology(topology)
        .rules(rules)
        .lessons(lessons)
        .skills(skill)
        .tools(baseTool)
        .grounding('SPEC.md')
        .instructions('Implement the ticket')
        .timeoutMinutes(15)
        .beforeStop(check)
        .input(workItemSchema)
        .partitions((item) => item.targetPartitions)
        .output(workReceiptSchema)
        .canRaise(normativeEscalation);

      const guardedWorker = worker
        .withPolicy(basePolicy)
        .onInterrupt(leaseRequest, ($intr) =>
          $intr
            .adjudicateWith(adjudicator, (item, req) => ({ item, req }))
            .onInterrupt(normativeEscalation, ($esc) =>
              $esc
                .ask(owner, z.object({ approved: z.boolean() }))
                .elevateLeaseWhen(
                  (d) => d.approved,
                  () => leaseDelta,
                )
                .resumeWith((d) => `Owner: ${d.approved}`),
            )
            .elevateLeaseWhen(
              (_item, _req, verdict) => verdict.approved,
              () => leaseDelta,
            )
            .resumeWith((_item, _req, verdict) => verdict.ruling),
        );

      expect(worker.roleKey).toBe('worker');
      expect(guardedWorker.roleKey).toBe('worker');
      expect(guardedWorker.policyDef).toBe(basePolicy);
      expect(guardedWorker.prefixGroupDef).toBe(prefixGroup);
      expect(guardedWorker.topologyDef).toBe(topology);
      expect(guardedWorker.rulesDef).toBe(rules);
      expect(guardedWorker.lessonsConfig).toEqual({ lessons, recordOutcomes: true });
      expect(guardedWorker.skillEntries).toEqual([skill]);
      expect(guardedWorker.beforeStopChecks).toEqual([check]);
      expect(guardedWorker.extractPartitions?.({ ref: '#1', targetPartitions: ['db', 'api'] })).toEqual([
        'db',
        'api',
      ]);
      const leaseHandler = guardedWorker.interruptHandlers['lease-request'];
      expect(leaseHandler?.adjudicatorConfig?.adjudicator).toBe(adjudicator);
      expect(
        leaseHandler?.adjudicatorConfig?.mapInput(
          { ref: '#1', targetPartitions: ['db'] },
          { requestedPaths: ['src/db.ts'] },
        ),
      ).toEqual({
        item: { ref: '#1', targetPartitions: ['db'] },
        req: { requestedPaths: ['src/db.ts'] },
      });
      expect(leaseHandler?.leaseElevations).toHaveLength(1);
      expect(
        leaseHandler?.leaseElevations[0]?.predicate(
          { ref: '#1', targetPartitions: ['db'] },
          { requestedPaths: ['src/db.ts'] },
          { approved: true, ruling: 'ok' },
        ),
      ).toBe(true);
      expect(
        leaseHandler?.leaseElevations[0]?.predicate(
          { ref: '#1', targetPartitions: ['db'] },
          { requestedPaths: ['src/db.ts'] },
          { approved: false, ruling: 'no' },
        ),
      ).toBe(false);
      expect(
        leaseHandler?.leaseElevations[0]?.leaseMapper(
          { ref: '#1', targetPartitions: ['db'] },
          { requestedPaths: ['src/db.ts'] },
          { approved: true, ruling: 'ok' },
        ),
      ).toBe(leaseDelta);
      expect(
        leaseHandler?.resumeFeedbackMapper?.(
          { ref: '#1', targetPartitions: ['db'] },
          { requestedPaths: ['src/db.ts'] },
          { approved: false, ruling: 'denied' },
        ),
      ).toBe('denied');

      const nestedHandler = leaseHandler?.nestedInterruptHandlers['normative-escalation'];
      expect(nestedHandler?.human).toBe(owner);
      expect(nestedHandler?.leaseElevations).toHaveLength(1);
      expect(nestedHandler?.leaseElevations[0]?.predicate({ approved: true })).toBe(true);
      expect(nestedHandler?.leaseElevations[0]?.predicate({ approved: false })).toBe(false);
      expect(nestedHandler?.leaseElevations[0]?.leaseMapper({ approved: true })).toBe(leaseDelta);
      expect(nestedHandler?.feedbackMapper?.({ approved: true })).toBe('Owner: true');

      const workerWithTools = guardedWorker.withTools([extraToolA, extraToolB]);
      expect(workerWithTools.roleKey).toBe('worker+tools:diff_candidates,eval_in_candidates');
      expect(workerWithTools.mountedTools).toEqual([baseTool, extraToolA, extraToolB]);
      expect(workerWithTools.interruptHandlers['lease-request']).toBe(leaseHandler);

      const evaluator = H.agent('evaluator')
        .policy(H.policy('read-only'))
        .input(z.object({ item: workItemSchema, candidate: workReceiptSchema }))
        .output(evalResultSchema);

      const verifiedWorkerLoop = H.loop('verified-worker-loop')
        .input(workItemSchema)
        .output(workReceiptSchema)
        .partitions((item) => item.targetPartitions)
        .maxIterations(3)
        .preserveActorSession(true)
        .distillLessonsInto(lessons)
        .act('execute', guardedWorker)
        .evaluate('evaluate', evaluator, {
          mapInput: (item, candidate) => ({ item, candidate }),
          acceptWhen: (ev) => ev.accepted,
          feedbackMapper: (ev) => ev.deficits.join(', '),
        })
        .returnOutputFrom('execute');

      const fastLoop = verifiedWorkerLoop.withPolicy(fastPolicy);
      expect(fastLoop.policyOverride).toBe(fastPolicy);
      expect(fastLoop.actStep).toBeDefined();
      expect(fastLoop.evaluateStep).toBeDefined();
      expect(fastLoop.actStep?.actor).not.toBe(guardedWorker);
      const fastInnerActor = fastLoop.actStep!.actor as typeof guardedWorker;
      expect(fastInnerActor.policyDef).toBe(fastPolicy);
      expect(fastInnerActor.interruptHandlers['lease-request']).toBe(leaseHandler);
      expect(fastInnerActor.beforeStopChecks).toEqual([check]);
      expect(fastInnerActor.prefixGroupDef).toBe(prefixGroup);
      const fastEvalActor = fastLoop.evaluateStep!.evaluator as typeof evaluator;
      expect(fastEvalActor.policyDef?.id).toBe('read-only');
      expect(fastLoop.extractPartitions?.({ ref: '#1', targetPartitions: ['db'] })).toEqual(['db']);
      expect(fastLoop.maxIterationsLimit).toBe(3);
      expect(fastLoop.preserveSession).toBe(true);
      expect(fastLoop.lessonsDef).toBe(lessons);
      expect(fastLoop.returnOutputStepId).toBe('execute');
      expect(
        fastLoop.evaluateStep?.mapInput(
          { ref: '#1', targetPartitions: ['db'] },
          { summary: 'cand' },
          {},
        ),
      ).toEqual({
        item: { ref: '#1', targetPartitions: ['db'] },
        candidate: { summary: 'cand' },
      });
      expect(fastLoop.evaluateStep?.acceptWhen({ accepted: true, deficits: [] })).toBe(true);
      expect(fastLoop.evaluateStep?.acceptWhen({ accepted: false, deficits: ['fix'] })).toBe(false);
      expect(fastLoop.evaluateStep?.feedbackMapper({ accepted: false, deficits: ['fix', 'lint'] })).toBe(
        'fix, lint',
      );

      const refinedLoop = verifiedWorkerLoop.withTools([extraToolA, extraToolB]);
      expect(refinedLoop.roleKey).toBe(
        'verified-worker-loop+tools:diff_candidates,eval_in_candidates',
      );
      expect(refinedLoop.actStep).toBeDefined();
      const refinedInnerActor = refinedLoop.actStep!.actor as typeof guardedWorker;
      expect(refinedInnerActor.roleKey).toBe('worker+tools:diff_candidates,eval_in_candidates');
      expect(refinedInnerActor.mountedTools).toEqual([baseTool, extraToolA, extraToolB]);
      expect(refinedLoop.extractPartitions?.({ ref: '#1', targetPartitions: ['db'] })).toEqual(['db']);
      expect(refinedLoop.maxIterationsLimit).toBe(3);
      expect(refinedLoop.preserveSession).toBe(true);
      expect(refinedLoop.lessonsDef).toBe(lessons);
      expect(refinedLoop.returnOutputStepId).toBe('execute');
      expect(refinedLoop.evaluateStep?.acceptWhen({ accepted: true, deficits: [] })).toBe(true);
      expect(refinedLoop.evaluateStep?.feedbackMapper({ accepted: false, deficits: ['fix'] })).toBe(
        'fix',
      );

      const ctx = createDummyExecutionContext({ worktreePath: '/tmp/wt' });
      await expect(
        workerWithTools.execute({ ref: '#42', targetPartitions: ['db'] }, ctx),
      ).rejects.toThrow(/StepExecutors have not been registered/);
      await expect(
        refinedLoop.execute({ ref: '#43', targetPartitions: ['api'] }, ctx),
      ).rejects.toThrow(/StepExecutors have not been registered/);

      const invoked: string[] = [];
      registerStepExecutors({
        async executeAgent(def, input) {
          invoked.push(`agent:${def.id}:${def.roleKey}`);
          const parsedIn = workItemSchema.parse(input);
          return def.outputSchema.parse({ summary: `agent-done:${parsedIn.ref}` });
        },
        async executeLoop(def, input) {
          invoked.push(`loop:${def.id}:${def.roleKey}`);
          const parsedIn = workItemSchema.parse(input);
          return def.outputSchema.parse({ summary: `loop-done:${parsedIn.ref}` });
        },
      });

      const agentOut = await workerWithTools.execute({ ref: '#42', targetPartitions: ['db'] }, ctx);
      const loopOut = await refinedLoop.execute({ ref: '#43', targetPartitions: ['api'] }, ctx);

      expect(agentOut).toEqual({ summary: 'agent-done:#42' });
      expect(loopOut).toEqual({ summary: 'loop-done:#43' });
      expect(invoked).toEqual([
        'agent:worker:worker+tools:diff_candidates,eval_in_candidates',
        'loop:verified-worker-loop:verified-worker-loop+tools:diff_candidates,eval_in_candidates',
      ]);
    });
  });

  describe('5. Core Zod Schemas & SpeculationInputSchema Validation', () => {
    it('validates SpeculationCandidateSchema, SpeculationInputSchema, ResumeForkInputSchema, BudgetApprovalSchema, DistilledLessonCandidateSchema, GlobalRuleSchema, ScopedRuleSchema, and SkillDefinitionSchema', () => {
      const itemSchema = z.object({ ref: z.string(), tags: z.array(z.string()).default(['default-tag']) });
      const outSchema = z.object({ summary: z.string() });
      const receiptSchema = z.object({ headSha: z.string() });
      const crossSchema = z.object({ passed: z.boolean() });
      const escSchema = z.object({ question: z.string() });

      const candSchema = SpeculationCandidateSchema(
        itemSchema,
        outSchema,
        receiptSchema,
        crossSchema,
        escSchema,
      );
      const completedCandidate = candSchema.parse({
        status: 'COMPLETED',
        branchIndex: 0,
        input: { ref: '#1' },
        output: { summary: 'Done' },
        scopeReceipt: { headSha: 'aaa' },
        crossVerifyReport: { passed: true },
      });
      expect(completedCandidate).toEqual({
        status: 'COMPLETED',
        branchIndex: 0,
        input: { ref: '#1', tags: ['default-tag'] },
        output: { summary: 'Done' },
        scopeReceipt: { headSha: 'aaa' },
        crossVerifyReport: { passed: true },
      });

      const parkedCandidate = candSchema.parse({
        status: 'PARKED_ON_ESCALATION',
        branchIndex: 1,
        input: { ref: '#1' },
        scopeReceipt: { headSha: 'bbb' },
        interruptId: 'normative-tradeoff',
        escalationPayload: { question: 'Which option?' },
      });
      expect(parkedCandidate.status).toBe('PARKED_ON_ESCALATION');
      if (parkedCandidate.status === 'PARKED_ON_ESCALATION') {
        expect(parkedCandidate.escalationPayload.question).toBe('Which option?');
      }

      const specInputSchema = SpeculationInputSchema(
        itemSchema,
        outSchema,
        receiptSchema,
        crossSchema,
        escSchema,
      );
      const parsedSpecInput = specInputSchema.parse({
        candidates: [completedCandidate, parkedCandidate],
      });
      expect(parsedSpecInput.failedBranches).toEqual([]);
      expect(parsedSpecInput.humanRulingsHistory).toEqual([]);
      expect(parsedSpecInput.candidates).toHaveLength(2);

      const parsedResume = ResumeForkInputSchema.parse({
        suspendedForkIds: ['fork-1#1'],
        resolutionSummary: 'Updated contract',
      });
      expect(parsedResume).toEqual({
        suspendedForkIds: ['fork-1#1'],
        action: 'resume',
        resolutionSummary: 'Updated contract',
      });
      expect(() =>
        ResumeForkInputSchema.parse({
          suspendedForkIds: [],
          resolutionSummary: 'Empty',
        }),
      ).toThrow();

      expect(BudgetApprovalSchema.parse({ approved: true, increaseLimitToUsd: 50 })).toEqual({
        approved: true,
        increaseLimitToUsd: 50,
      });

      expect(
        DistilledLessonCandidateSchema.parse({
          admit: true,
          partition: 'db',
          directive: 'Always index foreign keys',
        }),
      ).toEqual({
        admit: true,
        partition: 'db',
        directive: 'Always index foreign keys',
      });

      expect(GlobalRuleSchema.parse({ id: 'r1', directive: 'Rule 1' })).toEqual({
        id: 'r1',
        directive: 'Rule 1',
      });
      expect(() => GlobalRuleSchema.parse({ id: 'r1', directive: '' })).toThrow();

      const parsedScopedRule = ScopedRuleSchema.parse({
        id: 'sr1',
        when: {},
        directive: 'Scoped rule 1',
      });
      expect(parsedScopedRule).toEqual({
        id: 'sr1',
        when: { partitions: [] },
        directive: 'Scoped rule 1',
        checks: [],
      });

      const parsedSkill = SkillDefinitionSchema.parse({
        id: 'sk1',
        description: 'Skill 1',
        instructions: 'Follow steps',
      });
      expect(parsedSkill).toEqual({
        id: 'sk1',
        description: 'Skill 1',
        instructions: 'Follow steps',
        tools: [],
        services: [],
        lease: 'until-completed-or-fork-exit',
      });
    });
  });

  describe('6. Capability-Tiered Scope Static Validation & H.flow Typing', () => {
    it('accepts Tier-1 IsolationScope when guarded tools define describeEffects and .replaceWith() has an AbortHook, and rejects missing capabilities', () => {
      const tier1Scope = createTier1Scope();
      const tier2Scope = createTier2Scope();
      const tier3Scope = createTier3Scope();

      const guard: PolicyGuard = {
        kind: 'harness:policy-guard',
        id: 'refund-guard',
        evaluate: () => ({ allowed: true, violatedEffects: [], violationSummary: '' }),
      };
      const abortHook: AbortHook<{ readonly sessionId: string }, { readonly rolledBackId: string }> = {
        kind: 'harness:abort-hook',
        id: 'rollback-journal',
        metaSchema: z.object({ rolledBackId: z.string() }),
        async execute(handle) {
          return { rolledBackId: handle.sessionId };
        },
      };
      const approvalInterrupt = H.interrupt('high-value-approval').payload(
        z.object({ amountUsd: z.number() }),
      );
      const limitInterrupt = H.interrupt('limit-exceeded').payload(
        z.object({ summary: z.string() }),
      );
      const controller = H.human('controller').keepAliveSeconds(60);

      const safeTool: ToolDefinition = {
        kind: 'harness:tool',
        name: 'post_journal',
        description: 'Post journal entry',
        inputSchema: z.object({ amount: z.number() }),
        describeEffects: () => [{ kind: 'billing:effect', mutatesScope: true }],
        async execute() {
          return { content: 'posted' };
        },
      };

      const unsafeSubprocessTool: ToolDefinition = {
        kind: 'harness:tool',
        name: 'run_shell',
        description: 'Run arbitrary shell command',
        inputSchema: z.object({ cmd: z.string() }),
        async execute() {
          return { content: 'done' };
        },
      };

      const reconcilePolicy = H.policy('reconcile-policy')
        .guard(guard)
        .onViolation('raise-interrupt', approvalInterrupt, () => ({ amountUsd: 600 }))
        .onAbort(abortHook);

      const reconciler = H.agent('reconciler')
        .policy(reconcilePolicy)
        .tools(safeTool)
        .input(z.object({ discrepancyId: z.string() }))
        .output(z.object({ settled: z.boolean() }));

      const manualEscalator = H.agent('manual-escalator')
        .input(
          z.object({
            discrepancyId: z.string(),
            priorSummary: z.string(),
            rolledBackRef: z.string(),
          }),
        )
        .output(z.object({ settled: z.boolean() }));

      const tier1Flow = H.flow('reconcile-discrepancy')
        .input(z.object({ discrepancyId: z.string() }))
        .scope(tier1Scope)
        .step('attempt-reconcile', reconciler, ($s) =>
          $s
            .onInterrupt(approvalInterrupt, ($intr) =>
              $intr
                .ask(controller, z.object({ approved: z.boolean() }))
                .elevateLeaseWhen(
                  (d) => d.approved,
                  () => ({ kind: 'harness:lease-delta', id: 'l1', grantedMatchers: [] }),
                )
                .resumeWith((d) => `Approved: ${d.approved}`),
            )
            .onInterrupt(limitInterrupt, ($limit) =>
              $limit.onAbort(abortHook).replaceWith(manualEscalator, (item, payload, telemetry) => ({
                discrepancyId: item.discrepancyId,
                priorSummary: payload.summary,
                rolledBackRef: telemetry.abortMeta?.rolledBackId ?? 'none',
              })),
            ),
        )
        .exit('done');

      expect(tier1Flow.id).toBe('reconcile-discrepancy');
      expect(tier1Flow.terminalState).toBe('done');
      expect(tier1Flow.nodes).toHaveLength(1);

      const unguardedSubprocessAgent = H.agent('subprocess-guarded')
        .policy(H.policy('guarded').guard(guard).onViolation('deny-with-error'))
        .tools(unsafeSubprocessTool);

      expect(() =>
        H.flow('invalid-tier1-subprocess').scope(tier1Scope).step('run', unguardedSubprocessAgent),
      ).toThrow(/requires a CheckpointableScope/);

      expect(() =>
        H.flow('valid-tier2-subprocess').scope(tier2Scope).step('run', unguardedSubprocessAgent),
      ).not.toThrow();

      const skillWithSubprocessTool = H.skill('shell-skill')
        .description('Unlocks shell')
        .unlocksTools(unsafeSubprocessTool);
      const skillSubprocessAgent = H.agent('skill-subprocess-agent')
        .policy(H.policy('guarded').guard(guard).onViolation('deny-with-error'))
        .skills(skillWithSubprocessTool);

      expect(() =>
        H.flow('invalid-tier1-skill-subprocess')
          .scope(tier1Scope)
          .step('run', skillSubprocessAgent),
      ).toThrow(/requires a CheckpointableScope/);

      expect(() =>
        H.flow('valid-tier2-skill-subprocess').scope(tier2Scope).step('run', skillSubprocessAgent),
      ).not.toThrow();
    });

    it('enforces CheckpointableScope for .replaceWith() without AbortHook and BranchableScope for .fork() / .speculate() / .mutatePlan()', async () => {
      const tier1Scope = createTier1Scope();
      const tier2Scope = createTier2Scope();
      const tier3Scope = createTier3Scope();

      const intr = H.interrupt('escalate').payload(z.object({ reason: z.string() }));
      const actorNoAbort = H.agent('actor-no-abort').policy(H.policy('no-abort-policy'));
      const replacementActor = H.agent('replacement-actor');

      expect(() =>
        H.flow('missing-abort-hook-tier1')
          .scope(tier1Scope)
          .step('s1', actorNoAbort, ($s) =>
            $s.onInterrupt(intr, ($i) => $i.replaceWith(replacementActor, (inp) => inp)),
          ),
      ).toThrow(/uses \.replaceWith\(\) on interrupt 'escalate' without an AbortHook/);

      const validTier2Flow = H.flow('valid-replace-tier2')
        .scope(tier2Scope)
        .step('s1', actorNoAbort, ($s) =>
          $s.onInterrupt(intr, ($i) => $i.replaceWith(replacementActor, (inp) => inp)),
        );
      expect(validTier2Flow.nodes).toHaveLength(1);

      const childWorker = H.agent('child-worker')
        .input(z.object({ task: z.string() }))
        .output(z.object({ summary: z.string() }));

      const forkingCoordinator = H.agent('forking-coordinator')
        .input(z.object({ ref: z.string() }))
        .output(z.object({ summary: z.string() }))
        .capabilities(($cap) =>
          $cap.fork('delegate', childWorker, ($f) =>
            $f
              .historyMode('shared-prefix-only')
              .requestSchema(z.object({ task: z.string() }))
              .mapInput((_p, req) => ({ task: req.task })),
          ),
        );

      expect(() =>
        H.flow('invalid-fork-tier2').scope(tier2Scope).step('coord', forkingCoordinator),
      ).toThrow(/requires a BranchableScope/);

      const mutatingCoordinator = H.agent('mutating-coordinator').capabilities(($cap) =>
        $cap.mutatePlan(($m) =>
          $m.canSpawnTasks(z.object({ ref: z.string() }), {
            maxSpawnedPerRun: 2,
            onPrerequisiteSpawned: 'suspend-and-yield-slot',
          }),
        ),
      );

      expect(() =>
        H.flow('invalid-mutate-tier2').scope(tier2Scope).step('coord', mutatingCoordinator),
      ).toThrow(/requires a BranchableScope/);

      const speculatingCoordinator = H.agent('speculating-coordinator').capabilities(($cap) =>
        $cap.speculate('spec', ($s) =>
          $s.worker(childWorker).branches(2, () => [{ task: 'a' }, { task: 'b' }]),
        ),
      );

      expect(() =>
        H.flow('invalid-speculate-tier2').scope(tier2Scope).step('coord', speculatingCoordinator),
      ).toThrow(/requires a BranchableScope/);

      const telemetryCollector: TelemetryCollector<{ readonly filesRead: readonly string[] }> = {
        kind: 'harness:telemetry-collector',
        id: 'fs-telemetry',
        schema: z.object({ filesRead: z.array(z.string()) }),
        collect: () => ({ filesRead: ['a.ts'] }),
      };
      const gitAbortHook: AbortHook<
        { readonly worktreePath: string },
        { readonly abortedSnapshotRef: string }
      > = {
        kind: 'harness:abort-hook',
        id: 'git-snapshot',
        metaSchema: z.object({ abortedSnapshotRef: z.string() }),
        async execute() {
          return { abortedSnapshotRef: 'refs/harness/aborted/1' };
        },
      };

      const validTier3Flow = H.flow('valid-fork-tier3')
        .input(z.object({ ref: z.string(), tier: z.enum(['deep', 'leaf']) }))
        .scope(tier3Scope)
        .telemetry(telemetryCollector)
        .branch('execute-work', ($b) =>
          $b
            .output(z.object({ summary: z.string() }))
            .when(
              (item) => item.tier === 'deep',
              ($sub) => $sub.step('deep-step', forkingCoordinator),
            )
            .otherwise(($sub) =>
              $sub.step('leaf-step', childWorker, ($step) =>
                $step
                  .inputFrom((item) => ({ task: item.ref }))
                  .onInterrupt(intr, ($i) =>
                    $i.onAbort(gitAbortHook).replaceWith(forkingCoordinator, (item, payload, tel) => ({
                      ref: `${item.ref}:${payload.reason}:${tel.custom.filesRead.join(',')}:${tel.abortMeta?.abortedSnapshotRef ?? ''}`,
                      tier: 'deep' as const,
                    })),
                  ),
              ),
            ),
        )
        .step(
          'finalize',
          H.command('finalize-cmd', {
            inputSchema: z.object({
              workSummary: z.string(),
              headRef: z.string(),
            }),
            outputSchema: z.object({ published: z.boolean() }),
            async execute() {
              return { published: true };
            },
          }),
          ($s) =>
            $s.inputFrom((_item, steps, receipt) => ({
              workSummary: steps['execute-work'].summary,
              headRef: receipt.headRef,
            })),
        )
        .exit('done');

      expect(validTier3Flow.nodes).toHaveLength(2);
      expect(validTier3Flow.telemetryCollector?.id).toBe('fs-telemetry');
      expect(validTier3Flow.telemetryCollector?.collect([{ kind: 'fs:read' }])).toEqual({
        filesRead: ['a.ts'],
      });

      const branchNode = validTier3Flow.nodes[0] as FlowBranchNodeConfig;
      expect(branchNode.kind).toBe('branch');
      expect(branchNode.branchStepId).toBe('execute-work');
      expect(branchNode.arms).toHaveLength(2);
      expect(branchNode.arms[0]?.predicate?.({ ref: '#1', tier: 'deep' })).toBe(true);
      expect(branchNode.arms[0]?.predicate?.({ ref: '#1', tier: 'leaf' })).toBe(false);
      expect(branchNode.arms[0]?.step.stepId).toBe('deep-step');
      expect(branchNode.arms[0]?.step.executable).toBe(forkingCoordinator);
      expect(branchNode.arms[1]?.predicate).toBeUndefined();
      expect(branchNode.arms[1]?.step.stepId).toBe('leaf-step');
      expect(branchNode.arms[1]?.step.executable).toBe(childWorker);
      expect(
        branchNode.arms[1]?.step.inputMapper?.(
          { ref: '#1', tier: 'leaf' },
          {},
          { headRef: 'sha-1', diffStat: '1 file' },
        ),
      ).toEqual({ task: '#1' });

      const leafEscalateHandler = branchNode.arms[1]?.step.interruptHandlers['escalate'];
      expect(leafEscalateHandler?.abortHook).toBe(gitAbortHook);
      await expect(
        leafEscalateHandler?.abortHook?.execute({ worktreePath: '/tmp/wt' }, 'run-1'),
      ).resolves.toEqual({ abortedSnapshotRef: 'refs/harness/aborted/1' });
      expect(leafEscalateHandler?.replacementConfig?.replacement).toBe(forkingCoordinator);
      expect(
        leafEscalateHandler?.replacementConfig?.mapInput(
          { ref: '#1', tier: 'leaf' },
          { reason: 'stuck' },
          {
            turnsTaken: 3,
            costUsd: 0.5,
            durationMs: 100,
            custom: { filesRead: ['a.ts', 'b.ts'] },
            abortMeta: { abortedSnapshotRef: 'snap-123' },
          },
        ),
      ).toEqual({
        ref: '#1:stuck:a.ts,b.ts:snap-123',
        tier: 'deep',
      });

      const stepNode = validTier3Flow.nodes[1] as FlowStepNodeConfig;
      expect(stepNode.kind).toBe('step');
      expect(stepNode.stepId).toBe('finalize');
      expect(
        stepNode.inputMapper?.(
          { ref: '#1', tier: 'leaf' },
          { 'execute-work': { summary: 'done' } },
          { headRef: 'sha-999', diffStat: '1 file changed' },
        ),
      ).toEqual({
        workSummary: 'done',
        headRef: 'sha-999',
      });
      await expect(
        stepNode.executable.execute(
          { workSummary: 'done', headRef: 'sha-999' },
          createDummyExecutionContext({ worktreePath: '/tmp/wt' }),
        ),
      ).resolves.toEqual({ published: true });

      const publishArtifact = H.command('publish-artifact', {
        inputSchema: z.object({ ref: z.string() }),
        outputSchema: z.object({ published: z.boolean() }),
      });
      await expect(
        publishArtifact.execute({ ref: '#1' }, createDummyExecutionContext({ worktreePath: '/tmp/wt' })),
      ).rejects.toThrow(/has no execute implementation/);

      const execCmd = H.command('exec-cmd', {
        inputSchema: z.object({ ref: z.string() }),
        outputSchema: z.object({ published: z.boolean() }),
        async execute(inp) {
          return { published: inp.ref === '#1' };
        },
      });
      await expect(
        execCmd.execute({ ref: '#1' }, createDummyExecutionContext({ worktreePath: '/tmp/wt' })),
      ).resolves.toEqual({ published: true });

      expect(() =>
        H.flow('empty-when')
          .scope(tier3Scope)
          .branch('b', ($b) => $b.when(() => true, ($sub) => $sub)),
      ).toThrow(/must declare a \.step\(\)/);

      expect(() =>
        H.flow('empty-otherwise')
          .scope(tier3Scope)
          .branch('b', ($b) => $b.otherwise(($sub) => $sub)),
      ).toThrow(/must declare a \.step\(\)/);
    });
  });

  describe('7. Forbidden Async Closure Detection Across Builder Callbacks', () => {
    it('throws synchronously when an async function is passed to any control-flow predicate, mapper, or builder callback', () => {
      const sig = H.signal('sig').payload(z.object({ ref: z.string() }));
      const intr = H.interrupt('intr').payload(z.object({ reason: z.string() }));
      const stepExec = H.command('noop');
      const asyncFn = new Function('return async () => ({ ref: "x", reason: "y" })')();
      const asyncBool = new Function('return async () => true')();
      const asyncStr = new Function('return async () => "str"')();
      const asyncArr = new Function('return async () => ["db"]')();

      expect(() =>
        H.flow('f1').branch('b1', ($b) =>
          $b.when(asyncBool, ($s) => $s.step('s1', stepExec)),
        ),
      ).toThrow(/Async callback is forbidden/);

      expect(() =>
        H.flow('f2').step('s1', stepExec, ($s) =>
          $s.inputFrom(asyncFn),
        ),
      ).toThrow(/Async callback is forbidden/);

      expect(() =>
        H.flow('f3').step('s1', stepExec, ($s) =>
          $s.onInterrupt(intr, ($i) =>
            $i.replaceWith(stepExec, asyncFn),
          ),
        ),
      ).toThrow(/Async callback is forbidden/);

      expect(() =>
        H.agent('a1').onChildInterrupt(intr, ($c) =>
          $c.pauseSiblingForksInPartitions(asyncArr),
        ),
      ).toThrow(/Async callback is forbidden/);

      expect(() =>
        H.agent('a2').partitions(asyncArr),
      ).toThrow(/Async callback is forbidden/);

      expect(() =>
        H.lane('l1').onSignal(sig, ($s) =>
          $s.update(asyncFn),
        ),
      ).toThrow(/Async callback is forbidden/);

      expect(() =>
        H.stream('st1').filter(asyncBool),
      ).toThrow(/Async callback is forbidden/);

      expect(() =>
        H.policy('p1')
          .guard()
          .onViolation('deny-with-error', asyncStr),
      ).toThrow(/Async callback is forbidden/);

      expect(() =>
        H.pool('pool1').strategy(asyncFn),
      ).toThrow(/Async callback is forbidden/);
    });
  });

  describe('8. zodToJsonSchema Conversion', () => {
    it('converts nested objects, enums, arrays, defaults, literals, nullable, records, unions, and discriminated unions deterministically', () => {
      const complexSchema = z.object({
        id: z.string().min(1).max(64),
        count: z.number().min(0).max(100),
        active: z.boolean().default(true),
        tier: z.enum(['auto', 'leaf-only', 'deep']),
        tags: z.array(z.string()).min(1).max(5),
        note: z.string().nullable().optional(),
        metadata: z.record(z.number()),
        mode: z.union([z.literal('fast'), z.literal('thorough')]),
        verdict: z.discriminatedUnion('decision', [
          z.object({
            decision: z.literal('select-winner'),
            winnerBranchIndex: z.number(),
          }),
          z.object({
            decision: z.literal('reject-all'),
            rationale: z.string(),
          }),
        ]),
      });

      const jsonSchema = zodToJsonSchema(complexSchema);

      expect(jsonSchema).toEqual({
        type: 'object',
        additionalProperties: false,
        required: ['id', 'count', 'tier', 'tags', 'metadata', 'mode', 'verdict'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
          count: { type: 'number', minimum: 0, maximum: 100 },
          active: { type: 'boolean', default: true },
          tier: { type: 'string', enum: ['auto', 'leaf-only', 'deep'] },
          tags: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 5,
          },
          note: { type: 'string', nullable: true },
          metadata: {
            type: 'object',
            additionalProperties: { type: 'number' },
          },
          mode: {
            anyOf: [
              { type: 'string', const: 'fast', enum: ['fast'] },
              { type: 'string', const: 'thorough', enum: ['thorough'] },
            ],
          },
          verdict: {
            discriminator: { propertyName: 'decision' },
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['decision', 'winnerBranchIndex'],
                properties: {
                  decision: { type: 'string', const: 'select-winner', enum: ['select-winner'] },
                  winnerBranchIndex: { type: 'number' },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['decision', 'rationale'],
                properties: {
                  decision: { type: 'string', const: 'reject-all', enum: ['reject-all'] },
                  rationale: { type: 'string' },
                },
              },
            ],
            anyOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['decision', 'winnerBranchIndex'],
                properties: {
                  decision: { type: 'string', const: 'select-winner', enum: ['select-winner'] },
                  winnerBranchIndex: { type: 'number' },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['decision', 'rationale'],
                properties: {
                  decision: { type: 'string', const: 'reject-all', enum: ['reject-all'] },
                  rationale: { type: 'string' },
                },
              },
            ],
          },
        },
      });
    });
  });

  describe('9. End-to-End H.env, H.stream, H.lessons, H.agent Capabilities, H.lane & H.harness Assembly', () => {
    it('compiles a complete harness AST with opaque EnvRefs, streams, lessons, speculative capabilities, lane tracker/retry/signal configs, and root harness adapters', () => {
      const tokenRef = H.env('GITHUB_TOKEN');
      expect(tokenRef).toEqual({ kind: 'harness:env-ref', key: 'GITHUB_TOKEN' });

      const steerSignal = H.signal('steer').payload(z.object({ note: z.string() }));
      const lessonSignal = H.signal('high-leverage-lesson').payload(
        z.object({ lessonId: z.string(), directive: z.string() }),
      );
      const contractViolation = H.interrupt('contract-violation').payload(
        z.object({ partition: z.string(), brokenInvariant: z.string() }),
      );
      const normativeEscalation = H.interrupt('normative-tradeoff').payload(
        z.object({ question: z.string() }),
      );

      const streamSource: StreamSource<{ readonly merged: boolean; readonly ref: string }> = {
        kind: 'harness:stream-source',
        async subscribe() {
          return { async close() {} };
        },
      };
      const mergeStream = H.stream('merge-stream')
        .source(streamSource)
        .filter((ev) => ev.merged)
        .emitSignal(steerSignal, (ev) => ({ note: `Merged ${ev.ref}` }));

      expect(mergeStream.kind).toBe('harness:stream');
      expect(mergeStream.predicate?.({ merged: true, ref: '#1' })).toBe(true);
      expect(mergeStream.payloadMapper?.({ merged: true, ref: '#1' })).toEqual({
        note: 'Merged #1',
      });

      const workItem = z.object({
        ref: z.string(),
        title: z.string(),
        dependsOn: z.array(z.string()).default([]),
      });
      const workReceipt = z.object({ summary: z.string() });

      const lessonStore: LessonStore = {
        kind: 'harness:lesson-store',
        async queryCandidates() {
          return [];
        },
        async admit() {
          return 'lesson-1';
        },
        async recordOutcomes() {
          return [];
        },
        async syncCreationEpochsForRuns() {},
        async markSignalEmitted() {},
        async retire() {},
      };

      const repoLessons = H.lessons('repo-lessons')
        .store(lessonStore)
        .queryFrom(workItem, (i) => `${i.ref}: ${i.title}`)
        .distillWith('sonnet', ($d) =>
          $d.onLoopRecovery().onGateRecovery({ minFailedChecks: 2 }).guidelines('Guidelines'),
        )
        .scoring(($s) =>
          $s
            .slidingWindowInjections(20)
            .partitionMatchBoost(0.25)
            .decayOnPartitionEpochChange(0.85)
            .recall({ minScore: 0.2, maxItems: 5 }),
        )
        .retireAfter(($r) => $r.maxViolations(3).orMinCleanPassRate(0.35, { afterInjections: 12 }))
        .emitSignalWhen(
          lessonSignal,
          ($t) => $t.minCleanPasses(10).maxViolations(0).cooldownHours(72),
          (l) => ({ lessonId: l.id, directive: l.directive }),
        );

      expect(repoLessons.lessonStore).toBe(lessonStore);
      expect(
        repoLessons.queryExtractor?.({ ref: 'FEAT-9', title: 'Add index', dependsOn: [] }),
      ).toBe('FEAT-9: Add index');
      expect(repoLessons.distillConfig).toEqual({
        model: 'sonnet',
        onLoopRecovery: true,
        onGateRecovery: true,
        minFailedChecks: 2,
        guidelinesSource: 'Guidelines',
      });
      expect(repoLessons.scoringConfig).toEqual({
        slidingWindowInjections: 20,
        partitionMatchBoost: 0.25,
        decayOnPartitionEpochChange: 0.85,
        minScore: 0.2,
        maxItems: 5,
      });
      expect(repoLessons.retireConfig).toEqual({
        maxViolations: 3,
        minCleanPassRate: 0.35,
        afterInjections: 12,
      });
      expect(repoLessons.signalTriggers).toHaveLength(1);
      expect(repoLessons.signalTriggers[0]?.signal).toBe(lessonSignal);
      expect(repoLessons.signalTriggers[0]?.minCleanPasses).toBe(10);
      expect(repoLessons.signalTriggers[0]?.maxViolations).toBe(0);
      expect(repoLessons.signalTriggers[0]?.cooldownHours).toBe(72);
      expect(
        repoLessons.signalTriggers[0]?.mapper({
          id: 'L1',
          partition: 'db',
          directive: 'fix',
          epochAtCreation: 1,
          recentOutcomes: [],
          totalCleanPasses: 10,
          totalViolated: 0,
        }),
      ).toEqual({
        lessonId: 'L1',
        directive: 'fix',
      });

      const humanAdapter: HumanAdapter = {
        kind: 'harness:human-adapter',
        async notify() {},
        async requestDecision() {
          throw new Error('not called');
        },
      };
      const owner = H.human('owner').keepAliveSeconds(60).notify(humanAdapter);
      const budgetTarget = owner.withName('budget-approver').output(H.BudgetApprovalSchema);
      expect(budgetTarget.kind).toBe('harness:scoped-human');
      expect(budgetTarget.alias).toBe('budget-approver');

      const crossVerifier: CrossVerifier<
        { readonly worktreePath: string },
        { readonly headRef: string; readonly diffStat: string },
        { readonly crossPassed: boolean }
      > = {
        kind: 'harness:cross-verifier',
        reportSchema: z.object({ crossPassed: z.boolean() }),
        async verifyCandidates() {
          return [{ crossPassed: true }];
        },
      };

      const arbiterVerdictSchema = z.discriminatedUnion('decision', [
        z.object({
          decision: z.literal('select-winner'),
          winnerBranchIndex: z.number(),
          rationale: z.string(),
          followUpDeficits: z.array(z.string()).default([]),
        }),
        z.object({
          decision: z.literal('unpark-escalation'),
          parkedBranchIndex: z.number(),
          rationale: z.string(),
        }),
        z.object({
          decision: z.literal('reject-all'),
          rationale: z.string(),
        }),
      ]);

      const arbiter = H.agent('arbiter').output(arbiterVerdictSchema);
      const worker = H.agent('worker').input(workItem).output(workReceipt);
      const winnerEvaluator = H.agent('winner-evaluator')
        .input(z.object({ item: workItem, out: workReceipt }))
        .output(z.object({ passed: z.boolean() }));
      const topology = H.topology('topo').partitions({ db: {}, api: { dependsOn: ['db'] } });

      const coordinator = H.agent('coordinator')
        .input(workItem)
        .output(workReceipt)
        .lessons(repoLessons, { recordOutcomes: false })
        .capabilities(($cap) =>
          $cap
            .fork('delegate-partition', worker, ($f) =>
              $f
                .historyMode('shared-prefix-only')
                .requestSchema(z.object({ estimatedTurns: z.number() }))
                .mapInput((parentItem) => parentItem)
                .modelRouting(($m) =>
                  $m
                    .inheritParentWithEffort('medium', {
                      when: (_p, req) => req.estimatedTurns <= 6,
                    })
                    .otherwisePool('worker-pool'),
                ),
            )
            .speculate('explore-candidates', ($s) =>
              $s
                .requestSchema(z.object({ strategyA: z.string(), strategyB: z.string() }))
                .worker(worker)
                .branches(2, (parentItem, req) => [
                  { ...parentItem, title: req.strategyA },
                  { ...parentItem, title: req.strategyB },
                ])
                .verifyWinnerWith(winnerEvaluator, {
                  mapInput: (branchIn, branchOut) => ({ item: branchIn, out: branchOut }),
                  acceptWhen: (ev) => ev.passed,
                })
                .crossVerifyWith(crossVerifier)
                .arbiter(arbiter, { resolveDecision: (v) => v })
                .refineWinnerWhen(
                  (v) => v.decision === 'select-winner' && v.followUpDeficits.length > 0,
                  worker,
                  (parentItem) => parentItem,
                ),
            )
            .mutatePlan(($m) =>
              $m
                .canSpawnTasks(workItem, {
                  maxSpawnedPerRun: 6,
                  maxPrerequisiteDepth: 3,
                  enforcePatch: { title: 'spawned' },
                  onPrerequisiteSpawned: 'suspend-and-yield-slot',
                  priorityStrategy: 'inherit-parent-with-boost',
                  resumeWhen: 'prerequisite-exit',
                })
                .canAddDependencies()
                .canUpdateTopologyContracts(topology),
            )
            .escalate(normativeEscalation, ($esc) =>
              $esc
                .to(owner)
                .response(z.object({ approved: z.boolean() }))
                .elevateLeaseWhen(
                  (d) => d.approved,
                  () => ({ kind: 'harness:lease-delta', id: 'spec-lease', grantedMatchers: [] }),
                ),
            ),
        )
        .onChildInterrupt(contractViolation, ($intr) =>
          $intr
            .pauseSiblingForksInPartitions((v) =>
              topology.affectedBy(v.partition as 'db' | 'api'),
            )
            .suspendAndReturnToParent(),
        );

      expect(coordinator.lessonsConfig?.recordOutcomes).toBe(false);
      const forkConfig = coordinator.capabilitiesConfig.forks['delegate-partition'];
      expect(forkConfig?.childExecutable).toBe(worker);
      expect(forkConfig?.historyMode).toBe('shared-prefix-only');
      expect(
        forkConfig?.mapInput?.(
          { ref: '#1', title: 'T1', dependsOn: [] },
          { estimatedTurns: 4 },
        ),
      ).toEqual({ ref: '#1', title: 'T1', dependsOn: [] });
      expect(forkConfig?.modelRoutingConfig?.inheritEffort).toBe('medium');
      expect(
        forkConfig?.modelRoutingConfig?.inheritWhen?.(
          { ref: '#1', title: 'T1', dependsOn: [] },
          { estimatedTurns: 6 },
        ),
      ).toBe(true);
      expect(
        forkConfig?.modelRoutingConfig?.inheritWhen?.(
          { ref: '#1', title: 'T1', dependsOn: [] },
          { estimatedTurns: 7 },
        ),
      ).toBe(false);
      expect(forkConfig?.modelRoutingConfig?.fallbackPool).toBe('worker-pool');

      const specConfig = coordinator.capabilitiesConfig.speculations['explore-candidates'];
      expect(specConfig?.workerExecutable).toBe(worker);
      expect(specConfig?.branchCount).toBe(2);
      expect(
        specConfig?.branchesMapper?.(
          { ref: '#1', title: 'Base', dependsOn: [] },
          { strategyA: 'A', strategyB: 'B' },
        ),
      ).toEqual([
        { ref: '#1', title: 'A', dependsOn: [] },
        { ref: '#1', title: 'B', dependsOn: [] },
      ]);
      expect(specConfig?.singleWinnerVerifier?.evaluator).toBe(winnerEvaluator);
      expect(
        specConfig?.singleWinnerVerifier?.mapInput?.(
          { ref: '#1', title: 'A', dependsOn: [] },
          { summary: 'done' },
          {},
        ),
      ).toEqual({
        item: { ref: '#1', title: 'A', dependsOn: [] },
        out: { summary: 'done' },
      });
      expect(specConfig?.singleWinnerVerifier?.acceptWhen?.({ passed: true })).toBe(true);
      expect(specConfig?.singleWinnerVerifier?.acceptWhen?.({ passed: false })).toBe(false);
      expect(specConfig?.crossVerifier).toBe(crossVerifier);
      expect(specConfig?.arbiterConfig?.arbiterAgent).toBe(arbiter);
      expect(
        specConfig?.arbiterConfig?.resolveDecision({
          decision: 'select-winner',
          winnerBranchIndex: 0,
          rationale: 'best',
          followUpDeficits: ['polish'],
        }),
      ).toEqual({
        decision: 'select-winner',
        winnerBranchIndex: 0,
        rationale: 'best',
        followUpDeficits: ['polish'],
      });
      expect(
        specConfig?.refineWinnerConfig?.predicate({
          decision: 'select-winner',
          winnerBranchIndex: 0,
          rationale: 'needs-polish',
          followUpDeficits: ['polish'],
        }),
      ).toBe(true);
      expect(
        specConfig?.refineWinnerConfig?.predicate({
          decision: 'select-winner',
          winnerBranchIndex: 0,
          rationale: 'clean',
          followUpDeficits: [],
        }),
      ).toBe(false);
      expect(specConfig?.refineWinnerConfig?.refinementExecutable).toBe(worker);
      expect(
        specConfig?.refineWinnerConfig?.mapper(
          { ref: '#1', title: 'Base', dependsOn: [] },
          {
            decision: 'select-winner',
            winnerBranchIndex: 0,
            rationale: 'needs-polish',
            followUpDeficits: ['polish'],
          },
          [],
        ),
      ).toEqual({ ref: '#1', title: 'Base', dependsOn: [] });

      expect(
        coordinator.capabilitiesConfig.mutatePlanConfig?.spawnTasksConfig?.maxSpawnedPerRun,
      ).toBe(6);
      expect(coordinator.capabilitiesConfig.mutatePlanConfig?.allowAddDependencies).toBe(true);
      expect(coordinator.capabilitiesConfig.mutatePlanConfig?.writableTopology).toBe(topology);

      const escConfig = coordinator.capabilitiesConfig.escalations['normative-tradeoff'];
      expect(escConfig?.human).toBe(owner);
      expect(escConfig?.leaseElevations[0]?.predicate({ approved: true })).toBe(true);
      expect(escConfig?.leaseElevations[0]?.predicate({ approved: false })).toBe(false);
      expect(escConfig?.leaseElevations[0]?.leaseMapper({ approved: true })).toEqual({
        kind: 'harness:lease-delta',
        id: 'spec-lease',
        grantedMatchers: [],
      });

      expect(coordinator.childInterruptHandlers['contract-violation']?.suspendAndReturn).toBe(true);
      expect(
        coordinator.childInterruptHandlers['contract-violation']?.pausePartitionsMapper?.({
          partition: 'db',
          brokenInvariant: 'idx',
        }),
      ).toEqual(['db', 'api']);

      const flow = H.flow('eng-flow')
        .input(workItem)
        .scope(createTier3Scope())
        .step('coordinate', coordinator)
        .exit('done');

      const trackerAdapter: TrackerAdapter<
        { readonly num: number; readonly ready: boolean },
        'queued' | 'in-progress' | 'needs-human' | 'errored' | 'cancelled' | 'pr-open' | 'needs-triage'
      > = {
        kind: 'harness:tracker-adapter',
        async poll() {
          return [];
        },
        async setExternalState() {},
      };

      const rewindHook: ScopeRewindHook = {
        kind: 'harness:scope-rewind-hook',
        id: 'keep-worktree',
        async onRewind() {},
      };

      const lane = H.lane('engineering')
        .input(workItem)
        .key((i) => i.ref)
        .tracker(trackerAdapter, ($) =>
          $
            .everySeconds(60)
            .from((ext) =>
              ext.ready ? { ref: `#${ext.num}`, title: 'Issue', dependsOn: [] } : undefined,
            )
            .onQueued('queued')
            .onRunning('in-progress')
            .onWaiting('needs-human')
            .onErrored('errored')
            .onCancelled('cancelled')
            .onExit('done', 'pr-open')
            .onExit('exhausted', 'needs-triage'),
        )
        .flow(flow)
        .concurrency(4)
        .priority('high')
        .agingMinutes(30)
        .waitFor((i) => i.dependsOn, 'abandoned')
        .maxCostUsd(20, budgetTarget)
        .retry(($) => $.tries(2).exponential(5000).orFail('exhausted'))
        .onSignal(steerSignal, ($) =>
          $
            .update((cur, sig) => ({ ...cur, title: `${cur.title} (${sig.note})` }))
            .rewindTo('coordinate', { onRewind: rewindHook }),
        );

      expect(lane.keyMapper?.({ ref: 'R1', title: 'T', dependsOn: ['#0'] })).toBe('R1');
      expect(lane.waitForConfig?.depsMapper({ ref: 'R1', title: 'T', dependsOn: ['#0'] })).toEqual([
        '#0',
      ]);
      expect(lane.waitForConfig?.onAbandonedState).toBe('abandoned');
      expect(lane.maxCostConfig).toEqual({
        limitUsd: 20,
        approver: budgetTarget,
      });
      expect(lane.concurrencyLimit).toBe(4);
      expect(lane.priorityLevel).toBe('high');
      expect(lane.agingMins).toBe(30);
      expect(lane.trackerConfig?.adapter).toBe(trackerAdapter);
      expect(lane.trackerConfig?.pollIntervalSeconds).toBe(60);
      expect(lane.trackerConfig?.mapper?.({ num: 1, ready: true })).toEqual({
        ref: '#1',
        title: 'Issue',
        dependsOn: [],
      });
      expect(lane.trackerConfig?.mapper?.({ num: 1, ready: false })).toBeUndefined();
      expect(lane.trackerConfig?.stateMapping.onExit['done']).toBe('pr-open');
      expect(lane.retryConfig).toEqual({
        tries: 2,
        exponentialBaseDelayMs: 5000,
        failTerminalState: 'exhausted',
      });
      expect(
        lane.signalHandlers['steer']?.updateMapper?.(
          { ref: '#1', title: 'Issue', dependsOn: [] },
          { note: 'Merged #0' },
        ),
      ).toEqual({
        ref: '#1',
        title: 'Issue (Merged #0)',
        dependsOn: [],
      });
      expect(lane.signalHandlers['steer']?.rewindToStepId).toBe('coordinate');
      expect(lane.signalHandlers['steer']?.onRewindHook).toBe(rewindHook);

      const controlAdapter: ControlPlaneAdapter = {
        kind: 'harness:control-plane-adapter',
        async start() {
          return { async close() {} };
        },
      };

      const ledgerStore: LedgerStore = {
        kind: 'harness:ledger-store',
        async createOrResumeRun() {
          return {
            status: 'RUNNING',
            currentStepId: null,
            inputJson: '{}',
            costUsd: 0,
            completedStepOutputsJson: new Map(),
          };
        },
        async recordStepStart() {},
        async updateContinuationStack() {},
        async appendMessageFrame() {},
        async replaceMessageFrame() {},
        async markFrameTombstone() {},
        async getMessageChain() {
          return [];
        },
        async recordForkSuspension() {},
        async getSuspendedForks() {
          return [];
        },
        async resolveSuspendedFork() {},
        async recordStepTransition() {},
        async recordRunTerminalReceipt() {},
        async getRunTerminalReceipts() {
          return new Map();
        },
        async getInterruptedStepsOnBoot() {
          return [];
        },
        async compactRunFrames() {},
      };

      const harness = H.harness('acme-engineering')
        .ledger(ledgerStore)
        .pools('pool-1')
        .streams(mergeStream)
        .lanes(lane)
        .onSignal(lessonSignal, ($sig) =>
          $sig.notify(owner, (s) => `Lesson ${s.lessonId}: ${s.directive}`),
        )
        .expose(controlAdapter);

      expect(harness.kind).toBe('harness:root');
      expect(harness.id).toBe('acme-engineering');
      expect(harness.ledgerStore).toBe(ledgerStore);
      expect(harness.registeredPools).toEqual(['pool-1']);
      expect(harness.registeredStreams).toEqual([mergeStream]);
      expect(harness.registeredLanes).toEqual([lane]);
      expect(harness.signalHandlers['high-leverage-lesson']?.notifications).toHaveLength(1);
      expect(
        harness.signalHandlers['high-leverage-lesson']?.notifications[0]?.mapper({
          lessonId: 'L1',
          directive: 'D1',
        }),
      ).toBe('Lesson L1: D1');
      expect(harness.controlPlaneAdapters).toEqual([controlAdapter]);
      expect(() => createHarnessRuntime(harness)).toThrow(/HarnessRuntime is implemented in M2/);
    });
  });
});
