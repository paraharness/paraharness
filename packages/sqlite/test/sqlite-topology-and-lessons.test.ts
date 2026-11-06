import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteLessonStore, SqliteTopologyStore } from '../src/index.js';
import { createTempSqliteDb } from './fixtures/temp-sqlite-db.js';
import type { TempSqliteDbHandle } from './fixtures/temp-sqlite-db-handle.js';

describe('SqliteTopologyStore CoW overlays and SqliteLessonStore lifecycle', () => {
  let tempDb: TempSqliteDbHandle;
  let topologyStore: SqliteTopologyStore;
  let lessonStore: SqliteLessonStore;

  beforeEach(() => {
    tempDb = createTempSqliteDb();
    topologyStore = new SqliteTopologyStore(tempDb.dbPath);
    lessonStore = new SqliteLessonStore(tempDb.dbPath);
  });

  afterEach(() => {
    topologyStore.close();
    lessonStore.close();
    tempDb.cleanup();
  });

  it('isolates CoW overlay mutations, increments epoch at most once per run, and resets by step or run scope', async () => {
    const firstUpdate = await topologyStore.updateContract(
      'run-init',
      'auth',
      'line-1\nline-2\nline-3',
      'step-init-1',
    );
    expect(firstUpdate).toEqual({ newEpoch: 1 });
    expect((await topologyStore.getPartitions('run-init')).get('auth')?.epoch).toBe(1);

    const secondMutationInSameRun = await topologyStore.updateContract(
      'run-init',
      'auth',
      'line-1\nline-2-v2\nline-3',
      'step-init-2',
    );
    expect(secondMutationInSameRun).toEqual({ newEpoch: 1 });
    expect((await topologyStore.getPartitions('run-init')).get('auth')?.epoch).toBe(1);

    expect((await topologyStore.getPartitions()).size).toBe(0);

    await topologyStore.resetRunOverlay('run-init', {
      scope: 'step',
      stepExecId: 'step-init-2',
    });
    expect((await topologyStore.getPartitions('run-init')).get('auth')?.contractText).toBe(
      'line-1\nline-2\nline-3',
    );

    await topologyStore.sealRunOverlay('run-init');
    const commitInit = await topologyStore.commitRunOverlay('run-init');
    expect(commitInit).toEqual({
      committedRunIds: ['run-init'],
      updatedEpochs: new Map([['auth', 1]]),
    });
    const baseAuth = (await topologyStore.getPartitions()).get('auth');
    expect(baseAuth?.partitionId).toBe('auth');
    expect(baseAuth?.epoch).toBe(1);
    expect(baseAuth?.contractText).toBe('line-1\nline-2\nline-3');
    expect(baseAuth?.lastMutatedByRunId).toBe('run-init');

    await topologyStore.updateContract('run-discard', 'auth', 'broken-contract', 'step-d1');
    await topologyStore.resetRunOverlay('run-discard', { scope: 'run' });
    expect((await topologyStore.getPartitions('run-discard')).get('auth')?.contractText).toBe(
      'line-1\nline-2\nline-3',
    );
    await topologyStore.updateContract('run-discard', 'auth', 'discarded-text', 'step-d2');
    await topologyStore.discardRunOverlay('run-discard');
    expect((await topologyStore.getPartitions('run-discard')).get('auth')?.contractText).toBe(
      'line-1\nline-2\nline-3',
    );
  });

  it('advances baseContractTextAtAcquire across syncRunOverlays and performs 3-way merge on commitRunOverlay', async () => {
    await topologyStore.updateContract('run-base', 'billing', 'header\nbody\nfooter', 's-0');
    await topologyStore.sealRunOverlay('run-base');
    await topologyStore.commitRunOverlay('run-base');

    await topologyStore.getPartitions('run-a');
    await topologyStore.getPartitions('run-b');

    await topologyStore.updateContract('run-a', 'billing', 'header-a\nbody\nfooter', 's-a');
    await topologyStore.sealRunOverlay('run-a');
    await topologyStore.commitRunOverlay('run-a');

    await topologyStore.updateContract('run-b', 'billing', 'header\nbody\nfooter-b', 's-b');
    await topologyStore.sealRunOverlay('run-b');
    const mergedCommit = await topologyStore.commitRunOverlay('run-b');
    expect(mergedCommit).toEqual({
      committedRunIds: ['run-b'],
      updatedEpochs: new Map([['billing', 3]]),
    });
    expect((await topologyStore.getPartitions()).get('billing')?.contractText).toBe(
      'header-a\nbody\nfooter-b',
    );

    await topologyStore.updateContract(
      'run-prereq',
      'billing',
      'header-prereq\nbody\nfooter-b',
      's-p',
    );
    await topologyStore.sealRunOverlay('run-prereq');

    await topologyStore.syncRunOverlays('run-child', ['run-prereq']);
    const childSyncedView = (await topologyStore.getPartitions('run-child')).get('billing');
    expect(childSyncedView?.partitionId).toBe('billing');
    expect(childSyncedView?.epoch).toBe(4);
    expect(childSyncedView?.contractText).toBe('header-prereq\nbody\nfooter-b');
    expect(childSyncedView?.lastMutatedByRunId).toBe('run-prereq');

    await topologyStore.updateContract(
      'run-child',
      'billing',
      'header-prereq\nbody-child\nfooter-b',
      's-c',
    );
    await topologyStore.sealRunOverlay('run-child');
    const stackedCommit = await topologyStore.commitRunOverlay('run-child');
    expect(stackedCommit.committedRunIds).toEqual(['run-prereq', 'run-child']);
    expect(stackedCommit.updatedEpochs).toEqual(new Map([['billing', 4]]));
    expect((await topologyStore.getPartitions()).get('billing')?.contractText).toBe(
      'header-prereq\nbody-child\nfooter-b',
    );
  });

  it('admits, queries with relevanceScore, records outcomes, syncs epochs, marks signals, and retires lessons', async () => {
    const jwtLessonId = await lessonStore.admit({
      partition: 'auth',
      directive: 'Always index JWKS cache by kid and refresh on JWT signature verification miss.',
      epochAtCreation: 0,
      createdByRunId: 'run-lesson-1',
    });

    await lessonStore.admit({
      partition: undefined,
      directive: 'Share a single database connection pool across parallel steps.',
      epochAtCreation: 0,
      createdByRunId: 'run-lesson-2',
    });

    const candidates = await lessonStore.queryCandidates({
      queryText: 'JWT signature verification key rotation kid JWKS cache',
      partitions: ['auth'],
    });
    expect(candidates).toHaveLength(2);
    const jwtCandidate = candidates.find((c) => c.id === jwtLessonId);
    expect(jwtCandidate?.relevanceScore).toBeGreaterThan(0.2);

    await lessonStore.recordOutcomes([
      { lessonId: jwtLessonId, outcome: 'clean_pass' },
      { lessonId: jwtLessonId, outcome: 'violated' },
    ]);
    await lessonStore.syncCreationEpochsForRuns(
      ['run-lesson-1'],
      new Map([['auth', 5]]),
    );
    await lessonStore.markSignalEmitted(
      jwtLessonId,
      'sig-high-violation',
      '2026-01-02T00:00:00.000Z',
    );

    const updatedCandidates = await lessonStore.queryCandidates({
      queryText: 'JWT signature',
      partitions: ['auth'],
    });
    const updatedJwt = updatedCandidates.find((c) => c.id === jwtLessonId);
    expect(updatedJwt?.recentOutcomes).toEqual(['clean_pass', 'violated']);
    expect(updatedJwt?.totalCleanPasses).toBe(1);
    expect(updatedJwt?.totalViolated).toBe(1);
    expect(updatedJwt?.epochAtCreation).toBe(5);
    expect(updatedJwt?.signalLastEmittedAt).toEqual({
      'sig-high-violation': '2026-01-02T00:00:00.000Z',
    });

    await lessonStore.retire([jwtLessonId]);
    const afterRetire = await lessonStore.queryCandidates({
      queryText: 'JWT signature',
      partitions: ['auth'],
    });
    expect(afterRetire.map((c) => c.id)).not.toContain(jwtLessonId);
  });
});
