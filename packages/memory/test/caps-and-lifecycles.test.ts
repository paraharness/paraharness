import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  MemoryConfigSchema,
  MemoryMetaSchema,
  type MemoryNoteRecord,
  type MemoryRecord,
} from '../src/index.js';
import { evaluateNoteLifecycleOnRead } from '../src/internal/evaluate-note-lifecycle-on-read.js';
import { readMemoryLedger } from '../src/internal/read-memory-ledger.js';
import {
  isCapRuleEligibleForRecord,
  isContextCoveredByCapPattern,
  isRecordActiveForRepo,
  resolveRecordCapBucket,
} from '../src/internal/resolve-record-cap-bucket.js';
import {
  allocateNextMemoryRecordId,
  writeMemoryLedger,
} from '../src/internal/write-memory-ledger.js';
import { createTempMemoryWorkspace } from './fixtures/create-temp-memory-workspace.js';

describe('Capacity bucket specificity ranking, atomic ledger persistence & note lifecycles', () => {
  it('verifies isContextCoveredByCapPattern so file-restricted cap rules never capture broad directory records', () => {
    const repoFiles = [
      'packages/foo/src/index.ts',
      'packages/foo/test/foo.test.ts',
    ];
    expect(isContextCoveredByCapPattern('**/*.test.ts', 'packages/foo/**', repoFiles)).toBe(false);
    expect(isContextCoveredByCapPattern('**/*.test.ts', 'packages/foo', repoFiles)).toBe(false);
    expect(
      isContextCoveredByCapPattern('**/*.test.ts', 'packages/foo/test/foo.test.ts', repoFiles),
    ).toBe(true);
    expect(
      isContextCoveredByCapPattern('**/*.test.ts', 'packages/foo/**/*.test.ts', repoFiles),
    ).toBe(true);
    expect(
      isContextCoveredByCapPattern('packages/foo/**', 'packages/foo/**/*.test.ts', repoFiles),
    ).toBe(true);
    expect(isContextCoveredByCapPattern('packages/foo', 'packages/foo/src/index.ts', repoFiles)).toBe(
      true,
    );
  });

  it('ranks eligible cap rules by 6-tuple specificity (pathTier, maxPrefixSegments, maxPrefixChars, roleSpec, typeSpec, -i) and computes all 4 zones including maxTotalRecordsReached', () => {
    const config = MemoryConfigSchema.parse({
      repoId: 'repo-main',
      allowedRoles: ['general', 'builder', 'reviewer'],
      maxTotalRecords: 5,
      caps: [
        {
          roles: ['*'],
          paths: ['*'],
          types: ['lesson', 'note'],
          softCap: 10,
          hardCap: 20,
        },
        {
          roles: ['*'],
          paths: ['packages/**'],
          types: ['lesson'],
          softCap: 4,
          hardCap: 8,
        },
        {
          roles: ['*'],
          paths: ['packages/memory/**'],
          types: ['lesson'],
          softCap: 2,
          hardCap: 3,
        },
        {
          roles: ['builder'],
          paths: ['packages/memory/**'],
          types: ['lesson', 'note'],
          softCap: 2,
          hardCap: 3,
        },
        {
          roles: ['builder'],
          paths: ['packages/memory/**'],
          types: ['lesson'],
          softCap: 2,
          hardCap: 3,
        },
      ],
    });

    expect(
      isCapRuleEligibleForRecord(
        {
          roles: ['*'],
          paths: ['*'],
          types: ['lesson', 'note'],
          softCap: 10,
          hardCap: 20,
        },
        {
          type: 'lesson',
          role: 'builder',
          context: ['packages/memory/src/index.ts'],
        },
      ),
    ).toBe(true);
    expect(
      isCapRuleEligibleForRecord(
        {
          roles: ['*'],
          paths: ['*'],
          types: ['lesson', 'note'],
          softCap: 10,
          hardCap: 20,
        },
        {
          type: 'rule',
          role: 'builder',
          context: ['packages/memory/src/index.ts'],
        },
      ),
    ).toBe(false);

    const baseRecords: MemoryRecord[] = [
      {
        id: 'L1',
        type: 'lesson',
        role: 'builder',
        text: 'Do A when B, because C is required.',
        createdAt: '2026-11-09T10:00:00.000Z',
        context: ['packages/memory/src/index.ts'],
      },
      {
        id: 'L2',
        type: 'lesson',
        role: 'builder',
        text: 'Do D when E, because F is required.',
        createdAt: '2026-11-09T10:01:00.000Z',
        context: ['packages/memory/src/other.ts'],
      },
      {
        id: 'L99',
        type: 'lesson',
        role: 'builder',
        text: 'Ignored lesson for other repo, because repos filter excludes it.',
        createdAt: '2026-11-09T10:02:00.000Z',
        context: ['packages/memory/src/index.ts'],
        repos: ['other-repo'],
      },
    ];

    expect(isRecordActiveForRepo(baseRecords[0] ?? { repos: undefined }, 'repo-main')).toBe(true);
    expect(isRecordActiveForRepo(baseRecords[2] ?? { repos: ['other-repo'] }, 'repo-main')).toBe(
      false,
    );

    const underSoftStatus = resolveRecordCapBucket({
      candidate: {
        type: 'lesson',
        role: 'builder',
        context: ['packages/memory/src/new.ts'],
      },
      records: baseRecords.slice(0, 1),
      config,
    });
    expect(underSoftStatus).toEqual({
      bucketId: 'rule#4|role=builder|path=rule-paths:packages/memory/**',
      currentCount: 1,
      bucketRecordIds: ['L1'],
      softCap: 2,
      hardCap: 3,
      zone: 'UNDER_SOFT_CAP',
      totalRecordsCount: 1,
      maxTotalRecords: 5,
      maxTotalRecordsReached: false,
    });

    const softPressureStatus = resolveRecordCapBucket({
      candidate: {
        type: 'lesson',
        role: 'builder',
        context: ['packages/memory/src/new.ts'],
      },
      records: baseRecords,
      config,
    });
    expect(softPressureStatus.zone).toBe('SOFT_CAP_PRESSURE');
    expect(softPressureStatus.currentCount).toBe(2);
    expect(softPressureStatus.bucketRecordIds).toEqual(['L1', 'L2']);

    const hardCapRecords: MemoryRecord[] = [
      ...baseRecords,
      {
        id: 'L3',
        type: 'lesson',
        role: 'builder',
        text: 'Do G when H, because I is required.',
        createdAt: '2026-11-09T10:03:00.000Z',
        context: ['packages/memory/src/third.ts'],
      },
    ];
    const atHardCapStatus = resolveRecordCapBucket({
      candidate: {
        type: 'lesson',
        role: 'builder',
        context: ['packages/memory/src/new.ts'],
      },
      records: hardCapRecords,
      config,
    });
    expect(atHardCapStatus.zone).toBe('AT_HARD_CAP');
    expect(atHardCapStatus.currentCount).toBe(3);

    const uncappedRuleCandidate = {
      type: 'rule' as const,
      role: 'general',
    };
    const uncappedStatus = resolveRecordCapBucket({
      candidate: uncappedRuleCandidate,
      records: hardCapRecords,
      config,
    });
    expect(uncappedStatus.zone).toBe('UNCAPPED');
    expect(uncappedStatus.softCap).toBeNull();
    expect(uncappedStatus.hardCap).toBeNull();
    expect(uncappedStatus.bucketId).toBe('uncapped|type=rule|role=role:general|path=unscoped');

    const totalReachedRecords: MemoryRecord[] = [
      ...hardCapRecords,
      {
        id: 'R1',
        type: 'rule',
        role: 'general',
        text: 'Rule 1',
        createdAt: '2026-11-09T10:04:00.000Z',
      },
      {
        id: 'R2',
        type: 'rule',
        role: 'general',
        text: 'Rule 2',
        createdAt: '2026-11-09T10:05:00.000Z',
      },
    ];
    const uncappedButMaxTotalReached = resolveRecordCapBucket({
      candidate: uncappedRuleCandidate,
      records: totalReachedRecords,
      config,
    });
    expect(uncappedButMaxTotalReached.maxTotalRecordsReached).toBe(true);
    expect(uncappedButMaxTotalReached.zone).toBe('AT_HARD_CAP');
  });

  it('reads absent ledger as empty, sorts canonically on write, self-heals highWaterMarks before purging expired hard-expiry notes, and persists memory.meta.json before memory.jsonl (§8.1 Rule 2)', async () => {
    const ws = await createTempMemoryWorkspace();
    try {
      const emptySnap = await readMemoryLedger(ws.ledgerPath, Date.parse('2026-11-09T12:00:00.000Z'));
      expect(emptySnap.ledgerExisted).toBe(false);
      expect(emptySnap.metaExisted).toBe(false);
      expect(emptySnap.records).toEqual([]);
      expect(emptySnap.meta).toEqual({
        schemaVersion: 1,
        highWaterMarks: { R: 0, L: 0, N: 0 },
      });

      const unsortedRecords: MemoryRecord[] = [
        {
          id: 'N2',
          type: 'note',
          role: 'builder',
          text: 'Note 2',
          createdAt: '2026-11-09T10:00:00.000Z',
          lifecycle: { mode: 'persistent' },
        },
        {
          id: 'L10',
          type: 'lesson',
          role: 'general',
          text: 'Lesson 10',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
        {
          id: 'L2',
          type: 'lesson',
          role: 'general',
          text: 'Lesson 2',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
        {
          id: 'R3',
          type: 'rule',
          role: 'general',
          text: 'Rule 3',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
        {
          id: 'R1',
          type: 'rule',
          role: 'general',
          text: 'Rule 1',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
      ];

      const written = await writeMemoryLedger({
        ledgerPath: ws.ledgerPath,
        records: unsortedRecords,
      });
      expect(written.records.map((r) => r.id)).toEqual(['R1', 'R3', 'L2', 'L10', 'N2']);
      expect(written.meta.highWaterMarks).toEqual({ R: 3, L: 10, N: 2 });

      const expiredNote: MemoryNoteRecord = {
        id: 'N15',
        type: 'note',
        role: 'general',
        text: 'Hard expired note with high ID N15',
        createdAt: '2026-11-09T08:00:00.000Z',
        lifecycle: {
          mode: 'hard-expiry',
          expiresAt: '2026-11-09T09:00:00.000Z',
        },
      };
      await writeFile(
        ws.ledgerPath,
        `${[...written.records, expiredNote].map((r) => JSON.stringify(r)).join('\n')}\n`,
        'utf8',
      );

      const healedSnap = await readMemoryLedger(
        ws.ledgerPath,
        Date.parse('2026-11-09T12:00:00.000Z'),
      );
      expect(healedSnap.purgedExpiredNoteIds).toEqual(['N15']);
      expect(healedSnap.records.map((r) => r.id)).toEqual(['R1', 'R3', 'L2', 'L10', 'N2']);
      expect(healedSnap.meta.highWaterMarks).toEqual({ R: 3, L: 10, N: 15 });
      expect(healedSnap.metaNeedsWrite).toBe(true);
      expect(healedSnap.ledgerNeedsWrite).toBe(true);

      const nextNotedAlloc = allocateNextMemoryRecordId(healedSnap.meta, healedSnap.records, 'N');
      expect(nextNotedAlloc.id).toBe('N16');
    } finally {
      await ws.cleanup();
    }

    const failWs = await createTempMemoryWorkspace();
    try {
      await mkdir(failWs.ledgerPath, { recursive: true });
      const advancedRecord: MemoryRecord = {
        id: 'L42',
        type: 'lesson',
        role: 'general',
        text: 'Do X when Y, because Z.',
        createdAt: '2026-11-09T10:00:00.000Z',
      };
      await expect(
        writeMemoryLedger({
          ledgerPath: failWs.ledgerPath,
          records: [advancedRecord],
        }),
      ).rejects.toThrow();

      const persistedMetaRaw = await readFile(failWs.metaPath, 'utf8');
      const persistedMeta = MemoryMetaSchema.parse(JSON.parse(persistedMetaRaw));
      expect(persistedMeta.highWaterMarks).toEqual({ R: 0, L: 42, N: 0 });
    } finally {
      await failWs.cleanup();
    }
  });

  it('evaluates all 4 note lifecycles in evaluateNoteLifecycleOnRead (persistent, read-count without mutating updatedAt, hard-expiry, and soft-expiry)', () => {
    const nowMs = Date.parse('2026-11-09T12:00:00.000Z');

    const persistentNote: MemoryNoteRecord = {
      id: 'N1',
      type: 'note',
      role: 'general',
      text: 'Persistent architecture note',
      createdAt: '2026-11-09T10:00:00.000Z',
      lifecycle: { mode: 'persistent' },
    };
    const persistentEval = evaluateNoteLifecycleOnRead(persistentNote, nowMs);
    expect(persistentEval).toEqual({
      loadedNote: {
        ...persistentNote,
        drainedOnThisRead: false,
        renderedText: 'Persistent architecture note',
      },
      retainedNote: persistentNote,
      mutatedLedger: false,
    });

    const readCountTwoNote: MemoryNoteRecord = {
      id: 'N2',
      type: 'note',
      role: 'builder',
      text: 'Handoff note with 2 reads',
      createdAt: '2026-11-09T10:00:00.000Z',
      lifecycle: { mode: 'read-count', remainingReads: 2 },
    };
    const firstReadEval = evaluateNoteLifecycleOnRead(readCountTwoNote, nowMs);
    expect(firstReadEval.mutatedLedger).toBe(true);
    expect(firstReadEval.retainedNote?.updatedAt).toBeUndefined();
    expect(firstReadEval.retainedNote?.lifecycle).toEqual({
      mode: 'read-count',
      remainingReads: 1,
    });
    expect(firstReadEval.loadedNote).toEqual({
      ...readCountTwoNote,
      lifecycle: { mode: 'read-count', remainingReads: 1 },
      drainedOnThisRead: false,
      renderedText: 'Handoff note with 2 reads',
    });

    const secondReadEval = evaluateNoteLifecycleOnRead(
      firstReadEval.retainedNote ?? readCountTwoNote,
      nowMs,
    );
    expect(secondReadEval.mutatedLedger).toBe(true);
    expect(secondReadEval.retainedNote).toBeNull();
    expect(secondReadEval.loadedNote).toEqual({
      ...readCountTwoNote,
      lifecycle: { mode: 'read-count', remainingReads: 1 },
      drainedOnThisRead: true,
      renderedText: '[FINAL READ - DRAINED] Handoff note with 2 reads',
    });

    const activeHardNote: MemoryNoteRecord = {
      id: 'N3',
      type: 'note',
      role: 'general',
      text: 'Active hard-expiry note',
      createdAt: '2026-11-09T10:00:00.000Z',
      lifecycle: { mode: 'hard-expiry', expiresAt: '2026-11-09T13:00:00.000Z' },
    };
    const activeHardEval = evaluateNoteLifecycleOnRead(activeHardNote, nowMs);
    expect(activeHardEval.mutatedLedger).toBe(false);
    expect(activeHardEval.loadedNote?.drainedOnThisRead).toBe(false);

    const expiredHardNote: MemoryNoteRecord = {
      ...activeHardNote,
      lifecycle: { mode: 'hard-expiry', expiresAt: '2026-11-09T11:00:00.000Z' },
    };
    const expiredHardEval = evaluateNoteLifecycleOnRead(expiredHardNote, nowMs);
    expect(expiredHardEval).toEqual({
      loadedNote: null,
      retainedNote: null,
      mutatedLedger: true,
    });

    const activeSoftNote: MemoryNoteRecord = {
      id: 'N4',
      type: 'note',
      role: 'general',
      text: 'Soft-expiry note',
      createdAt: '2026-11-09T10:00:00.000Z',
      lifecycle: { mode: 'soft-expiry', expiresAt: '2026-11-09T13:00:00.000Z' },
    };
    expect(evaluateNoteLifecycleOnRead(activeSoftNote, nowMs).mutatedLedger).toBe(false);

    const expiredSoftNote: MemoryNoteRecord = {
      ...activeSoftNote,
      lifecycle: { mode: 'soft-expiry', expiresAt: '2026-11-09T12:00:00.000Z' },
    };
    const expiredSoftEval = evaluateNoteLifecycleOnRead(expiredSoftNote, nowMs);
    expect(expiredSoftEval).toEqual({
      loadedNote: {
        ...expiredSoftNote,
        drainedOnThisRead: true,
        renderedText: '[FINAL READ - DRAINED] Soft-expiry note',
      },
      retainedNote: null,
      mutatedLedger: true,
    });
  });
});
