import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { H, createExecutorRegistry } from '@harness-dsl/core';
import type {
  AgentContinuationFrame,
  ResolutionContext,
  RuntimeDriverContext,
  SuspendedForkRecord,
  WireFrameRecord,
} from '@harness-dsl/core';
import {
  PostgresLedgerStore,
  PostgresLessonStore,
  PostgresTopologyStore,
  createCompactionConfigBuilder,
  createPostgresExecutors,
  createPostgresGlobalRulesBuilder,
  createPostgresLedgerBuilder,
  createPostgresLessonsBuilder,
  createPostgresTopologyBuilder,
  postgres,
  postgresExecutors,
} from '../src/index.js';
import { SqliteBackedPgClient } from './fixtures/sqlite-backed-pg-client.js';

function createSampleWireFrame(
  messageId: string,
  parentMessageId: string | null,
  rawText: string,
): WireFrameRecord {
  return {
    messageId,
    parentMessageId,
    vendorId: 'openai',
    rawWireFrame: new TextEncoder().encode(rawText),
    canonical: {
      role: 'assistant',
      visibleText: rawText,
      toolCalls: [{ id: `call-${messageId}`, name: 'fs:read', argsJson: '{"path":"b.ts"}' }],
      toolResults: [],
    },
    prefixDigest: `sha-${messageId}`,
    compactedTombstones: {},
  };
}

describe('@harness-dsl/postgres builders, late-bound EnvRef resolution, stores, and global-rules executor', () => {
  let pgClient: SqliteBackedPgClient;
  let ledgerStore: PostgresLedgerStore;
  let topologyStore: PostgresTopologyStore;
  let lessonStore: PostgresLessonStore;

  beforeEach(() => {
    pgClient = new SqliteBackedPgClient();
    ledgerStore = new PostgresLedgerStore(pgClient);
    topologyStore = new PostgresTopologyStore(pgClient);
    lessonStore = new PostgresLessonStore(pgClient);
  });

  afterEach(() => {
    pgClient.close();
  });

  it('builds frozen Postgres AST nodes with H.env(DATABASE_URL) and validates compaction and SQL identifiers', () => {
    const dbUrlEnv = H.env('DATABASE_URL');
    const mergedSig = H.signal('github:pr.merged', z.object({ prKey: z.string() })).toAST();
    const ledgerAst = postgres
      .ledger(dbUrlEnv)
      .compactWhen(($c) =>
        $c
          .onSignal(mergedSig, { correlateBy: (sig) => sig.prKey, afterGracePeriodHours: 12 })
          .onTerminalExit(['FAILED'], { afterGracePeriodHours: 48 })
          .retainFailedRunsForDays(14),
      )
      .toAST();

    expect(Object.isFrozen(ledgerAst)).toBe(true);
    expect(ledgerAst.type).toBe('postgres:ledger');
    expect(ledgerAst.uri).toEqual(dbUrlEnv);
    expect(ledgerAst.compaction?.signalTriggers[0]?.afterGracePeriodHours).toBe(12);
    expect(ledgerAst.compaction?.signalTriggers[0]?.correlateBy({ prKey: 'PR-7' })).toBe('PR-7');
    expect(ledgerAst.compaction?.terminalExitTriggers).toEqual([
      { states: ['FAILED'], afterGracePeriodHours: 48 },
    ]);
    expect(ledgerAst.compaction?.retainFailedRunsForDays).toBe(14);

    const topologyAst = postgres.topologyStore(dbUrlEnv).toAST();
    const lessonsAst = postgres.lessonStore(dbUrlEnv).toAST();
    const rulesAst = postgres.globalRules(dbUrlEnv, { table: 'pg_global_rules' }).toAST();

    expect(topologyAst).toEqual({ type: 'postgres:topology', uri: dbUrlEnv });
    expect(lessonsAst).toEqual({ type: 'postgres:lessons', uri: dbUrlEnv });
    expect(rulesAst).toEqual({
      type: 'postgres:global-rules',
      id: 'postgres:global-rules:env:DATABASE_URL:pg_global_rules',
      uri: dbUrlEnv,
      table: 'pg_global_rules',
    });

    expect(createPostgresLedgerBuilder('postgres://localhost/db').toAST().uri).toBe('postgres://localhost/db');
    expect(createPostgresTopologyBuilder('postgres://localhost/db').toAST().uri).toBe('postgres://localhost/db');
    expect(createPostgresLessonsBuilder('postgres://localhost/db').toAST().uri).toBe('postgres://localhost/db');
    expect(createPostgresGlobalRulesBuilder('postgres://localhost/db', { table: 'rules_v1' }).toAST().table).toBe('rules_v1');
    expect(() => postgres.ledger('   ')).toThrow(/non-empty database URI/);
    expect(() => postgres.topologyStore('')).toThrow(/non-empty database URI/);
    expect(() => postgres.lessonStore('   ')).toThrow(/non-empty database URI/);
    expect(() => postgres.globalRules(dbUrlEnv, { table: 'invalid; DROP TABLE runs;' })).toThrow(/Invalid PostgreSQL identifier/);
    expect(() => createCompactionConfigBuilder().retainFailedRunsForDays(-3)).toThrow(/positive finite number/);
    expect(postgresExecutors.sources?.['postgres:global-rules']).toBeTypeOf('function');
  });

  it('resolves H.env(DATABASE_URL) at runtime for postgres:global-rules and store factories', async () => {
    await pgClient.query('CREATE TABLE pg_global_rules (id TEXT PRIMARY KEY, directive TEXT NOT NULL);');
    await pgClient.query('INSERT INTO pg_global_rules (id, directive) VALUES ($1, $2)', ['rule-2', 'Release scope locks in finally.']);
    await pgClient.query('INSERT INTO pg_global_rules (id, directive) VALUES ($1, $2)', ['rule-1', 'Never read .env directly.']);

    const slice = createPostgresExecutors(pgClient);
    const resolutionCtx: ResolutionContext = {
      runId: 'run-pg-rules',
      activePartitions: ['core'],
      observedEffects: [],
      resolveEnv(envOrUri) {
        if (typeof envOrUri === 'string') return envOrUri;
        return envOrUri.key === 'DATABASE_URL' ? 'postgres://test-host:5432/harness' : undefined;
      },
    };
    const driverCtx: RuntimeDriverContext = {
      registry: createExecutorRegistry([slice]),
      resolveEnv: resolutionCtx.resolveEnv,
      getRunner() {
        throw new Error('Runner not used in postgres tests.');
      },
    };

    const rulesExecutor = slice.sources?.['postgres:global-rules'];
    if (rulesExecutor === undefined) throw new Error('Missing postgres:global-rules executor');
    const rulesNode = postgres.globalRules(H.env('DATABASE_URL'), { table: 'pg_global_rules' }).toAST();
    const artifact = await rulesExecutor(rulesNode, undefined, resolutionCtx);
    const expectedRules = [
      { id: 'rule-1', directive: 'Never read .env directly.' },
      { id: 'rule-2', directive: 'Release scope locks in finally.' },
    ];
    const expectedDigest = createHash('sha256').update(JSON.stringify(expectedRules), 'utf8').digest('hex');

    expect(pgClient.lastRequestedUri).toBe('postgres://test-host:5432/harness');
    expect(artifact).toEqual({ content: expectedRules, digest: expectedDigest });

    const ledgerFactory = slice.ledgers?.['postgres:ledger'];
    const topologyFactory = slice.topologies?.['postgres:topology'];
    const lessonFactory = slice.lessons?.['postgres:lessons'];
    if (ledgerFactory === undefined || topologyFactory === undefined || lessonFactory === undefined) {
      throw new Error('Missing postgres store factories');
    }
    const resolvedLedger = await ledgerFactory(postgres.ledger(H.env('DATABASE_URL')).toAST(), driverCtx);
    const resolvedTopology = await topologyFactory(postgres.topologyStore(H.env('DATABASE_URL')).toAST(), driverCtx);
    const resolvedLessons = await lessonFactory(postgres.lessonStore(H.env('DATABASE_URL')).toAST(), driverCtx);

    const createdRun = await resolvedLedger.createOrResumeRun({
      runId: 'run-factory-1',
      laneId: 'lane-1',
      itemKey: 'ISS-PG-1',
      inputJson: '{}',
    });
    expect(createdRun.status).toBe('RUNNING');
    expect((await resolvedTopology.getPartitions()).size).toBe(0);
    expect(await resolvedLessons.queryCandidates({ queryText: 'lock', partitions: [] })).toEqual([]);
  });

  it('executes PostgresLedgerStore lifecycle, DAG cycle/depth validation, fork epochs, and isolated frame compaction', async () => {
    const startRes = await ledgerStore.createOrResumeRun({
      runId: 'pg-run-1', laneId: 'lane-pg', itemKey: 'ISS-10', inputJson: '{"step":0}',
      compiledPrefixesJson: { main: '{"pinned":true}' }, costUsd: 0.5, approvedMaxCostUsd: 20,
    });
    expect(startRes.compiledPrefixesJson).toEqual({ main: '{"pinned":true}' });

    await ledgerStore.recordStepStart({
      stepExecId: 'pg-step-1', runId: 'pg-run-1', stepId: 'act-1', executableId: 'actor-1',
      inputMsgId: null, baseScopeCheckpoint: 'cp-0', continuationStack: [],
    });

    const agentFrame: AgentContinuationFrame = {
      kind: 'agent-frame', agentId: 'actor-1', roleKey: 'role-1', modelId: 'gpt-4o',
      stepExecId: 'pg-step-1', inputJson: '{"step":0}', leafMessageId: 'pg-m-1',
      turnsTaken: 1, costUsd: 0.1, elapsedDurationMs: 50, activeLeases: [], activeSkillIds: [],
      activeSkillActivations: {}, observedEffects: [], injectedScopedRuleIds: [],
      pausedAtPhase: 'TOOL_BOUNDARY',
      pauseState: { kind: 'active-turn', inFlightPreToolCheckpoint: 'cp-in-flight-pg' },
    };
    await ledgerStore.updateContinuationStack('pg-run-1', 'pg-step-1', [agentFrame], { baseScopeCheckpoint: 'cp-1' });
    await ledgerStore.updateRunInput('pg-run-1', { inputJson: '{"step":1}', rewindPendingToStepId: 'act-0' });

    const bootRecords = await ledgerStore.getInterruptedStepsOnBoot();
    expect(bootRecords).toHaveLength(1);
    expect(bootRecords[0]?.baseScopeCheckpoint).toBe('cp-1');

    await ledgerStore.recordStepTransition({
      stepExecId: 'pg-step-1', status: 'COMPLETED', outputJson: '{"ok":true}', telemetryJson: '{"status":"COMPLETED"}',
    });
    await expect(
      ledgerStore.recordStepTransition({ stepExecId: 'unknown-step', status: 'COMPLETED', telemetryJson: '{}' }),
    ).rejects.toThrow(/unknown stepExecId/i);

    const betweenStepsBoot = await ledgerStore.getInterruptedStepsOnBoot();
    expect(betweenStepsBoot).toEqual([
      {
        runId: 'pg-run-1', laneId: 'lane-pg', itemKey: 'ISS-10', inputJson: '{"step":1}',
        status: 'RUNNING', dependsOn: [], stepExecId: null, stepId: null,
        executableId: undefined, baseScopeCheckpoint: undefined, headScopeCheckpoint: undefined,
        continuationStack: [],
      },
    ]);

    const resumed = await ledgerStore.createOrResumeRun({
      runId: 'pg-run-1', laneId: 'lane-pg', itemKey: 'ISS-10',
      inputJson: '{"ignored":true}', compiledPrefixesJson: { main: '{"overwritten":false}' },
    });
    expect(resumed.compiledPrefixesJson).toEqual({ main: '{"pinned":true}' });
    expect(resumed.completedStepOutputsJson.get('act-1')).toBe('{"ok":true}');

    await ledgerStore.mutateLanePlan({
      laneId: 'lane-pg', parentRunId: 'pg-run-1', parentItemKey: 'ISS-10',
      spawnedItems: [
        { itemKey: 'C_1', inputJson: '{"c":1}', dependsOn: [], priority: 'normal' },
        { itemKey: 'C_2', inputJson: '{"c":2}', dependsOn: [], priority: 'high' },
      ],
      addedDependencies: [], maxPrerequisiteDepth: 3,
    });

    const bootAfterSpawn = await ledgerStore.getInterruptedStepsOnBoot();
    expect(
      bootAfterSpawn.map((entry) => ({ itemKey: entry.itemKey, status: entry.status, dependsOn: entry.dependsOn })),
    ).toEqual([
      { itemKey: 'ISS-10', status: 'RUNNING', dependsOn: ['C_2'] },
      { itemKey: 'C_1', status: 'QUEUED', dependsOn: [] },
      { itemKey: 'C_2', status: 'QUEUED', dependsOn: ['C_1'] },
    ]);

    await expect(
      ledgerStore.mutateLanePlan({
        laneId: 'lane-pg', parentRunId: 'pg-run-1', parentItemKey: 'C_1',
        spawnedItems: [], addedDependencies: ['ISS-10'], maxPrerequisiteDepth: 5,
      }),
    ).rejects.toThrow(/cycle/i);

    await expect(
      ledgerStore.mutateLanePlan({
        laneId: 'lane-pg', parentRunId: 'pg-run-1', parentItemKey: 'P_above',
        spawnedItems: [], addedDependencies: ['ISS-10'], maxPrerequisiteDepth: 2,
      }),
    ).rejects.toThrow(/maxPrerequisiteDepth/);

    const fork1: SuspendedForkRecord = {
      suspendedForkId: 'f-pg#1', forkId: 'f-pg', suspensionEpoch: 1, runId: 'pg-run-1',
      parentStepExecId: 'pg-step-1', forkToolName: 'fork_worker', activePartitions: ['db'],
      suspensionReason: 'INTERRUPT_RAISED', conflictRetryCount: 0, conflictCheckArmed: false, continuationStack: [],
    };
    await ledgerStore.recordForkSuspension(fork1);
    await ledgerStore.recordForkSuspension({ ...fork1, suspendedForkId: 'f-pg#2', suspensionEpoch: 2 });
    expect((await ledgerStore.getSuspendedForks('pg-run-1')).map((f) => f.suspendedForkId)).toEqual(['f-pg#1', 'f-pg#2']);
    await ledgerStore.resolveSuspendedFork('f-pg#3', 'ABORTED');
    expect(await ledgerStore.getSuspendedForks('pg-run-1')).toEqual([]);

    await ledgerStore.createOrResumeRun({ runId: 'pg-run-active', laneId: 'lane-pg', itemKey: 'ISS-10', inputJson: '{}' });
    await ledgerStore.appendMessageFrame('pg-run-1', createSampleWireFrame('pm-1', null, 'root'));
    await ledgerStore.appendMessageFrame('pg-run-1', createSampleWireFrame('pm-2', 'pm-1', 'leaf'));
    await ledgerStore.appendMessageFrame('pg-run-active', createSampleWireFrame('pm-active', null, 'active-body'));
    await expect(
      ledgerStore.replaceMessageFrame('pg-run-1', createSampleWireFrame('pm-missing', null, 'x')),
    ).rejects.toThrow(/frame not found/i);
    await expect(
      ledgerStore.markFrameTombstone('pg-run-1', 'pm-missing', 'call-x', '[Tombstone]'),
    ).rejects.toThrow(/unknown messageId/i);
    await ledgerStore.markFrameTombstone('pg-run-1', 'pm-1', 'call-pm-1', '[Tombstone]');
    await ledgerStore.recordRunTerminalReceipt('pg-run-1', 'ISS-10', 'done', '{"sha":"999"}');
    expect((await ledgerStore.getRunTerminalReceipts(['ISS-10'])).get('ISS-10')?.terminalState).toBe('done');

    await ledgerStore.compactRunFrames('pg-run-1');
    const compactedChain = await ledgerStore.getMessageChain('pm-2');
    expect(compactedChain[0]?.rawWireFrame.byteLength).toBe(0);
    expect(compactedChain[0]?.compactedTombstones).toEqual({ 'call-pm-1': '[Tombstone]' });
    expect(new TextDecoder().decode((await ledgerStore.getMessageChain('pm-active'))[0]?.rawWireFrame)).toBe('active-body');
  });

  it('executes PostgresTopologyStore CoW overlays, 3-way merge, syncRunOverlays, and PostgresLessonStore lifecycle', async () => {
    const [concurrentA, concurrentB] = await Promise.all([
      topologyStore.updateContract('r-1', 'api', 'v1-top\nv1-bottom', 's-1'),
      topologyStore.updateContract('r-1', 'api', 'v1-top\nv1-mid\nv1-bottom', 's-2'),
    ]);
    expect(concurrentA).toEqual({ newEpoch: 1 });
    expect(concurrentB).toEqual({ newEpoch: 1 });
    await topologyStore.resetRunOverlay('r-1', { scope: 'step', stepExecId: 's-2' });
    expect((await topologyStore.getPartitions('r-1')).get('api')?.contractText).toBe('v1-top\nv1-bottom');
    await topologyStore.sealRunOverlay('r-1');
    const committed = await topologyStore.commitRunOverlay('r-1');
    expect(committed).toEqual({ committedRunIds: ['r-1'], updatedEpochs: new Map([['api', 1]]) });

    await topologyStore.getPartitions('r-branch-a');
    await topologyStore.getPartitions('r-branch-b');
    await topologyStore.updateContract('r-branch-a', 'api', 'v2-top\nv1-bottom\nv2-extra', 's-ba');
    await topologyStore.sealRunOverlay('r-branch-a');
    await topologyStore.commitRunOverlay('r-branch-a');

    await topologyStore.updateContract('r-branch-b', 'api', 'v1-top\nv2-bottom', 's-bb');
    await topologyStore.sealRunOverlay('r-branch-b');
    const mergedBranchB = await topologyStore.commitRunOverlay('r-branch-b');
    expect(mergedBranchB).toEqual({ committedRunIds: ['r-branch-b'], updatedEpochs: new Map([['api', 3]]) });
    expect((await topologyStore.getPartitions()).get('api')?.contractText).toBe('v2-top\nv2-extra\nv2-bottom');

    await topologyStore.updateContract('r-prereq', 'api', 'v3-prereq\nv2-extra\nv2-bottom', 's-p');
    await topologyStore.sealRunOverlay('r-prereq');
    await topologyStore.updateContract('r-parent', 'api', 'v2-top\nv2-extra\nv3-parent', 's-par');
    await topologyStore.syncRunOverlays('r-parent', ['r-prereq']);
    expect((await topologyStore.getPartitions('r-parent')).get('api')?.contractText).toBe(
      'v3-prereq\nv2-extra\nv3-parent',
    );
    expect((await topologyStore.getPartitions('r-parent')).get('api')?.lastMutatedByRunId).toBe('r-parent');

    await topologyStore.resetRunOverlay('r-parent', { scope: 'run' });
    expect((await topologyStore.getPartitions('r-parent')).get('api')?.contractText).toBe(
      'v3-prereq\nv2-extra\nv2-bottom',
    );
    await topologyStore.sealRunOverlay('r-parent');
    const stackedCommit = await topologyStore.commitRunOverlay('r-parent');
    expect(stackedCommit.committedRunIds).toEqual(['r-prereq', 'r-parent']);
    expect(stackedCommit.updatedEpochs).toEqual(new Map([['api', 4]]));

    await topologyStore.updateContract('r-discard', 'api', 'discard-me', 's-d');
    await topologyStore.discardRunOverlay('r-discard');
    expect((await topologyStore.getPartitions('r-discard')).get('api')?.contractText).toBe(
      'v3-prereq\nv2-extra\nv2-bottom',
    );

    const lessonId = await lessonStore.admit({
      partition: 'api',
      directive: 'Always validate pagination cursor signatures before querying.',
      epochAtCreation: 0,
      createdByRunId: 'r-1',
    });
    await lessonStore.syncCreationEpochsForRuns(['r-1'], committed.updatedEpochs);
    await lessonStore.recordOutcomes([{ lessonId, outcome: 'clean_pass' }]);
    await lessonStore.markSignalEmitted(lessonId, 'sig-promote', '2026-02-01T00:00:00.000Z');

    const recalled = await lessonStore.queryCandidates({ queryText: 'pagination cursor signatures', partitions: ['api'] });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.epochAtCreation).toBe(1);
    expect(recalled[0]?.totalCleanPasses).toBe(1);
    expect(recalled[0]?.signalLastEmittedAt).toEqual({ 'sig-promote': '2026-02-01T00:00:00.000Z' });

    await lessonStore.retire([lessonId]);
    expect(await lessonStore.queryCandidates({ queryText: 'pagination cursor', partitions: ['api'] })).toEqual([]);
  });
});
