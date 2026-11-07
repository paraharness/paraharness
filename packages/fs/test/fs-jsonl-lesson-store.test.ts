import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsJsonlLessonStore, fs } from '../src/index.js';
import type { TempFsWorkspaceHandle } from './fixtures/temp-fs-workspace-handle.js';
import { createTempFsWorkspace } from './fixtures/temp-fs-workspace.js';

describe('@harness-dsl/fs FsJsonlLessonStore', () => {
  const workspaces: TempFsWorkspaceHandle[] = [];

  afterEach(async () => {
    while (workspaces.length > 0) {
      const ws = workspaces.pop();
      if (ws !== undefined) await ws.cleanup();
    }
  });

  it('admits immutable lesson definitions and resolves paths against hostRoot', async () => {
    const ws = await createTempFsWorkspace();
    workspaces.push(ws);

    const storeNode = fs.jsonlLessonStore({
      definitionsDir: '.harness/lessons',
      statsPath: '.harness/lesson-stats.json',
      lockFile: '.harness/lessons.lock',
    });
    const store = new FsJsonlLessonStore(storeNode, ws.rootDir);

    const admittedId = await store.admit({
      partition: 'api',
      directive: 'Never import drizzle-orm directly inside packages/api route handlers.',
      epochAtCreation: 2,
      createdByRunId: 'run-101',
    });
    expect(admittedId).toMatch(/^lesson-/);

    const defPath = join(ws.rootDir, '.harness/lessons', `${admittedId}.json`);
    const rawDef = JSON.parse(await readFile(defPath, 'utf8')) as Record<string, unknown>;
    expect(rawDef).toEqual({
      id: admittedId,
      partition: 'api',
      directive: 'Never import drizzle-orm directly inside packages/api route handlers.',
      epochAtCreation: 2,
      createdByRunId: 'run-101',
    });

    const duplicateId = await store.admit({
      partition: 'api',
      directive: 'Never import drizzle-orm directly inside packages/api route handlers.',
      epochAtCreation: 2,
      createdByRunId: 'run-101',
    });
    expect(duplicateId).toBe(admittedId);

    const queried = await store.queryCandidates({
      queryText: 'drizzle-orm packages/api route handlers',
      partitions: ['api'],
    });
    expect(queried).toHaveLength(1);
    expect(queried[0]?.id).toBe(admittedId);
    expect(queried[0]?.partition).toBe('api');
    expect(queried[0]?.epochAtCreation).toBe(2);
    expect(queried[0]?.createdByRunId).toBe('run-101');
  });

  it('serializes concurrent recordOutcomes calls via advisory lock and atomic statsPath rename', async () => {
    const ws = await createTempFsWorkspace();
    workspaces.push(ws);

    const storeNode = fs.jsonlLessonStore({
      definitionsDir: '.harness/lessons',
      statsPath: '.harness/lesson-stats.json',
      lockFile: '.harness/lessons.lock',
    });
    const store = new FsJsonlLessonStore(storeNode, ws.rootDir);

    const lessonAId = await store.admit({
      partition: 'db',
      directive: 'Always wrap multi-table migrations in a transaction.',
      epochAtCreation: 1,
      createdByRunId: 'run-a',
    });
    const lessonBId = await store.admit({
      partition: 'api',
      directive: 'Validate request query parameters using Zod schemas.',
      epochAtCreation: 1,
      createdByRunId: 'run-b',
    });

    await Promise.all([
      new FsJsonlLessonStore(storeNode, ws.rootDir).recordOutcomes([
        { lessonId: lessonAId, outcome: 'clean_pass' },
      ]),
      new FsJsonlLessonStore(storeNode, ws.rootDir).recordOutcomes([
        { lessonId: lessonAId, outcome: 'violated' },
      ]),
      new FsJsonlLessonStore(storeNode, ws.rootDir).recordOutcomes([
        { lessonId: lessonAId, outcome: 'gate_rejected_recovered' },
      ]),
      new FsJsonlLessonStore(storeNode, ws.rootDir).recordOutcomes([
        { lessonId: lessonBId, outcome: 'clean_pass' },
        { lessonId: lessonBId, outcome: 'clean_pass' },
      ]),
    ]);

    const candidates = await store.queryCandidates({
      queryText: 'migrations transaction Zod schemas',
      partitions: ['db', 'api'],
    });
    const recordA = candidates.find((c) => c.id === lessonAId);
    const recordB = candidates.find((c) => c.id === lessonBId);
    expect(recordA).toBeDefined();
    expect(recordB).toBeDefined();
    expect(recordA?.totalCleanPasses).toBe(1);
    expect(recordA?.totalViolated).toBe(1);
    expect(recordA?.recentOutcomes).toHaveLength(3);
    expect(recordB?.totalCleanPasses).toBe(2);
    expect(recordB?.totalViolated).toBe(0);
  });

  it('updates epochs via syncCreationEpochsForRuns, records markSignalEmitted, retires lessons, and scores query relevance', async () => {
    const ws = await createTempFsWorkspace();
    workspaces.push(ws);

    const storeNode = fs.jsonlLessonStore({
      definitionsDir: '.harness/lessons',
      statsPath: '.harness/lesson-stats.json',
      lockFile: '.harness/lessons.lock',
    });
    const store = new FsJsonlLessonStore(storeNode, ws.rootDir);

    const dbLessonId = await store.admit({
      partition: 'db',
      directive: 'Create composite PostgreSQL indexes concurrently on foreign keys.',
      epochAtCreation: 1,
      createdByRunId: 'run-prereq-1',
    });
    const uiLessonId = await store.admit({
      partition: 'web',
      directive: 'Use semantic ARIA labels on interactive dialog buttons.',
      epochAtCreation: 1,
      createdByRunId: 'run-prereq-2',
    });

    await store.syncCreationEpochsForRuns(
      ['run-prereq-1'],
      new Map<string, number>([['db', 5]]),
    );
    await store.markSignalEmitted(dbLessonId, 'lesson-promotion', '2026-11-07T00:00:00.000Z');

    const beforeRetire = await store.queryCandidates({
      queryText: 'PostgreSQL indexes foreign keys',
      partitions: ['db', 'web'],
    });
    expect(beforeRetire).toHaveLength(2);
    const syncedDb = beforeRetire.find((c) => c.id === dbLessonId);
    const otherUi = beforeRetire.find((c) => c.id === uiLessonId);
    expect(syncedDb?.epochAtCreation).toBe(5);
    expect(syncedDb?.signalLastEmittedAt?.['lesson-promotion']).toBe(
      '2026-11-07T00:00:00.000Z',
    );
    expect((syncedDb?.relevanceScore ?? 0) > (otherUi?.relevanceScore ?? 0)).toBe(true);

    await store.retire([uiLessonId]);
    const afterRetire = await store.queryCandidates({
      queryText: 'ARIA labels dialog buttons',
      partitions: ['db', 'web'],
    });
    expect(afterRetire.map((c) => c.id)).toEqual([dbLessonId]);

    const fuzzyAndPrefixRank = await store.admit({
      partition: 'db',
      directive: 'Always validate foreign key cascades before dropping tables.',
      epochAtCreation: 1,
      createdByRunId: 'run-prereq-3',
    });
    const bm25Ranked = await store.queryCandidates({
      queryText: 'postgressql concurr',
      partitions: ['db'],
    });
    expect(bm25Ranked.map((c) => c.id)).toEqual([dbLessonId, fuzzyAndPrefixRank]);
    expect((bm25Ranked[0]?.relevanceScore ?? 0) > (bm25Ranked[1]?.relevanceScore ?? 0)).toBe(true);
  });
});
