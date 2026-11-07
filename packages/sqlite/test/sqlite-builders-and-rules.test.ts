import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { H, createExecutorRegistry } from '@harness-dsl/core';
import type { ResolutionContext, RuntimeDriverContext } from '@harness-dsl/core';
import {
  SqliteLedgerStore,
  SqliteLessonStore,
  SqliteTopologyStore,
  createCompactionConfigBuilder,
  createSqliteExecutors,
  createSqliteGlobalRulesBuilder,
  createSqliteLedgerBuilder,
  createSqliteLessonsBuilder,
  createSqliteTopologyBuilder,
  sqlite,
  sqliteExecutors,
} from '../src/index.js';
import { createTempSqliteDb } from './fixtures/temp-sqlite-db.js';
import type { TempSqliteDbHandle } from './fixtures/temp-sqlite-db-handle.js';

function createTestResolutionContext(envMap: Readonly<Record<string, string>>): ResolutionContext {
  return {
    runId: 'run-rules-1',
    activePartitions: ['core'],
    observedEffects: [],
    scopeHandle: undefined,
    resolveEnv(value) {
      if (typeof value === 'string') {
        return envMap[value] ?? value;
      }
      return envMap[value.key];
    },
  };
}

function createTestDriverContext(envMap: Readonly<Record<string, string>>): RuntimeDriverContext {
  return {
    registry: createExecutorRegistry([sqliteExecutors]),
    resolveEnv(value) {
      if (typeof value === 'string') {
        return envMap[value] ?? value;
      }
      return envMap[value.key];
    },
    getRunner() {
      throw new Error('Runner pool not expected in sqlite unit tests.');
    },
  };
}

describe('sqlite AST builders and global-rules source executor', () => {
  let tempDb: TempSqliteDbHandle;

  beforeEach(() => {
    tempDb = createTempSqliteDb();
  });

  afterEach(() => {
    tempDb.cleanup();
  });

  it('builds frozen SqliteLedgerNode with compaction config and preserves immutability', () => {
    const mergedSig = H.signal('github:pr.merged', z.object({ issueKey: z.string() })).toAST();
    const baseBuilder = sqlite.ledger('.harness/state.sqlite');
    const configuredBuilder = baseBuilder.compactWhen(($c) =>
      $c
        .onSignal(mergedSig, {
          correlateBy: (payload) => payload.issueKey,
          afterGracePeriodHours: 24,
        })
        .onTerminalExit(['FAILED', 'CANCELED'], { afterGracePeriodHours: 72 })
        .retainFailedRunsForDays(7),
    );

    const baseAst = baseBuilder.toAST();
    const configuredAst = configuredBuilder.toAST();

    expect(Object.isFrozen(baseAst)).toBe(true);
    expect(baseAst).toEqual({
      type: 'sqlite:ledger',
      uri: '.harness/state.sqlite',
      compaction: undefined,
    });
    expect(Object.isFrozen(configuredAst)).toBe(true);
    expect(configuredAst.type).toBe('sqlite:ledger');
    expect(configuredAst.uri).toBe('.harness/state.sqlite');
    expect(configuredAst.compaction?.signalTriggers).toHaveLength(1);
    expect(configuredAst.compaction?.signalTriggers[0]?.signal).toEqual(mergedSig);
    expect(configuredAst.compaction?.signalTriggers[0]?.afterGracePeriodHours).toBe(24);
    expect(
      configuredAst.compaction?.signalTriggers[0]?.correlateBy({ issueKey: 'ISS-99' }),
    ).toBe('ISS-99');
    expect(configuredAst.compaction?.terminalExitTriggers).toEqual([
      {
        states: ['FAILED', 'CANCELED'],
        afterGracePeriodHours: 72,
      },
    ]);
    expect(configuredAst.compaction?.retainFailedRunsForDays).toBe(7);
  });

  it('validates compaction grace periods and retention days', () => {
    const compactionBuilder = createCompactionConfigBuilder();
    expect(() =>
      compactionBuilder.onTerminalExit(['COMPLETED'], { afterGracePeriodHours: -1 }),
    ).toThrow(/non-negative finite number/);
    expect(() => compactionBuilder.retainFailedRunsForDays(0)).toThrow(/positive finite number/);
  });

  it('builds frozen SqliteTopologyNode, SqliteLessonsNode, and SqliteRulesSourceNode', () => {
    const uri = '.harness/state.sqlite';
    const topologyAst = sqlite.topologyStore(uri).toAST();
    const lessonsAst = sqlite.lessonStore(uri).toAST();
    const rulesAst = sqlite.globalRules(uri, { table: 'owner_global_rules' }).toAST();

    expect(Object.isFrozen(topologyAst)).toBe(true);
    expect(topologyAst).toEqual({
      type: 'sqlite:topology',
      uri,
    });
    expect(Object.isFrozen(lessonsAst)).toBe(true);
    expect(lessonsAst).toEqual({
      type: 'sqlite:lessons',
      uri,
    });
    expect(Object.isFrozen(rulesAst)).toBe(true);
    expect(rulesAst).toEqual({
      type: 'sqlite:global-rules',
      id: 'sqlite:global-rules:.harness/state.sqlite:owner_global_rules',
      uri,
      table: 'owner_global_rules',
    });
  });

  it('supports direct factory functions and rejects unsafe SQL table identifiers', () => {
    expect(createSqliteLedgerBuilder('a.sqlite').toAST().uri).toBe('a.sqlite');
    expect(createSqliteTopologyBuilder('b.sqlite').toAST().uri).toBe('b.sqlite');
    expect(createSqliteLessonsBuilder('c.sqlite').toAST().uri).toBe('c.sqlite');
    expect(createSqliteGlobalRulesBuilder('d.sqlite', { table: 'valid_rules_1' }).toAST().table).toBe(
      'valid_rules_1',
    );
    expect(() => sqlite.globalRules('d.sqlite', { table: 'drop table --' })).toThrow(
      /Invalid SQLite identifier/,
    );
  });

  it('executes sqlite:global-rules source, validates GlobalRuleSchema, and computes SHA-256 digest', async () => {
    const rawDb = new BetterSqlite3(tempDb.dbPath);
    rawDb.exec(
      'CREATE TABLE owner_global_rules (id TEXT PRIMARY KEY, directive TEXT NOT NULL);',
    );
    rawDb
      .prepare('INSERT INTO owner_global_rules (id, directive) VALUES (?, ?)')
      .run('rule-b', 'Never force push to main.');
    rawDb
      .prepare('INSERT INTO owner_global_rules (id, directive) VALUES (?, ?)')
      .run('rule-a', 'Always validate fencing tokens.');
    rawDb.close();

    const rulesNode = sqlite
      .globalRules(tempDb.dbPath, { table: 'owner_global_rules' })
      .toAST();
    const executors = createSqliteExecutors();
    const sourceExecutor = executors.sources?.['sqlite:global-rules'];
    if (sourceExecutor === undefined) {
      throw new Error('Expected sqlite:global-rules executor to be registered.');
    }

    const artifact = await sourceExecutor(
      rulesNode,
      undefined,
      createTestResolutionContext({}),
    );
    const expectedRules = [
      { id: 'rule-a', directive: 'Always validate fencing tokens.' },
      { id: 'rule-b', directive: 'Never force push to main.' },
    ];
    const expectedDigest = createHash('sha256')
      .update(JSON.stringify(expectedRules), 'utf8')
      .digest('hex');

    expect(artifact).toEqual({
      content: expectedRules,
      digest: expectedDigest,
    });
  });

  it('instantiates ledger, topology, and lesson stores via sqliteExecutors registry slice', async () => {
    const driverCtx = createTestDriverContext({});
    const ledgerFactory = sqliteExecutors.ledgers?.['sqlite:ledger'];
    const topologyFactory = sqliteExecutors.topologies?.['sqlite:topology'];
    const lessonFactory = sqliteExecutors.lessons?.['sqlite:lessons'];
    if (
      ledgerFactory === undefined ||
      topologyFactory === undefined ||
      lessonFactory === undefined
    ) {
      throw new Error('Expected sqlite store factories in sqliteExecutors.');
    }

    const ledgerStore = await ledgerFactory(sqlite.ledger(tempDb.dbPath).toAST(), driverCtx);
    const topologyStore = await topologyFactory(
      sqlite.topologyStore(tempDb.dbPath).toAST(),
      driverCtx,
    );
    const lessonStore = await lessonFactory(
      sqlite.lessonStore(tempDb.dbPath).toAST(),
      driverCtx,
    );
    try {
      const runResult = await ledgerStore.createOrResumeRun({
        runId: 'run-slice-1',
        laneId: 'lane-1',
        itemKey: 'item-1',
        inputJson: '{"hello":"world"}',
        compiledPrefixesJson: { default: '{}' },
        approvedMaxCostUsd: 5,
      });
      expect(runResult.status).toBe('RUNNING');

      const partitions = await topologyStore.getPartitions('run-slice-1');
      expect(partitions.size).toBe(0);

      const candidates = await lessonStore.queryCandidates({
        queryText: 'sqlite',
        partitions: ['core'],
      });
      expect(candidates).toEqual([]);
    } finally {
      (ledgerStore as SqliteLedgerStore).close();
      (topologyStore as SqliteTopologyStore).close();
      (lessonStore as SqliteLessonStore).close();
    }
  });
});
