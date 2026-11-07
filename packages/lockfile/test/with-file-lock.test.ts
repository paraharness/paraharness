import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_PATH_QUEUES } from '../src/file-lock.constants.js';
import { acquireFileLock, withFileLock } from '../src/index.js';
import { tryReclaimStaleLock } from '../src/internal/stale-lock-helpers.js';

interface DeferredLatch {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferredLatch(): DeferredLatch {
  let resolveFn: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

describe('@harness-dsl/lockfile — cross-process and in-process file locking', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'harness-lockfile-test-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent in-process callers in strict FIFO order via PQueue and cleans up lockfile on release', async () => {
    const lockPath = path.join(tempDir, 'nested', 'state.lock');
    const executionOrder: string[] = [];
    const firstEntered = createDeferredLatch();
    const releaseFirst = createDeferredLatch();

    const firstTask = withFileLock(lockPath, async () => {
      executionOrder.push('first-enter');
      const rawRecord = JSON.parse(await readFile(lockPath, 'utf8')) as {
        readonly pid: number;
        readonly ownerToken: string;
      };
      expect(rawRecord.pid).toBe(process.pid);
      expect(rawRecord.ownerToken.length).toBeGreaterThan(0);
      firstEntered.resolve();
      await releaseFirst.promise;
      executionOrder.push('first-exit');
      return 'first-done';
    });

    await firstEntered.promise;

    const secondTask = withFileLock(lockPath, async () => {
      executionOrder.push('second-enter');
      return 'second-done';
    });

    const thirdTask = withFileLock(lockPath, async () => {
      executionOrder.push('third-enter');
      return 'third-done';
    });

    expect(executionOrder).toEqual(['first-enter']);
    releaseFirst.resolve();

    const results = await Promise.all([firstTask, secondTask, thirdTask]);
    expect(results).toEqual(['first-done', 'second-done', 'third-done']);
    expect(executionOrder).toEqual(['first-enter', 'first-exit', 'second-enter', 'third-enter']);
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('automatically reclaims a stale lockfile left behind by a dead holder PID (simulated SIGKILL crash)', async () => {
    const lockPath = path.join(tempDir, 'crashed-holder.lock');
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999_999_999,
        acquiredAtMs: Date.now(),
        ownerToken: 'dead-holder-token',
      }),
      'utf8',
    );

    const lease = await acquireFileLock(lockPath, {
      staleMs: 60_000,
      timeoutMs: 1_000,
      retryDelayMs: 5,
    });
    try {
      expect(lease.lockPath).toBe(path.resolve(lockPath));
      expect(lease.ownerToken).not.toBe('dead-holder-token');
      const reclaimedRecord = JSON.parse(await readFile(lockPath, 'utf8')) as {
        readonly pid: number;
        readonly ownerToken: string;
      };
      expect(reclaimedRecord.pid).toBe(process.pid);
      expect(reclaimedRecord.ownerToken).toBe(lease.ownerToken);
    } finally {
      await lease.release();
      await lease.release();
    }

    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('automatically reclaims a lockfile whose mtime heartbeat has expired past staleMs', async () => {
    const lockPath = path.join(tempDir, 'expired-heartbeat.lock');
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        acquiredAtMs: Date.now() - 30_000,
        ownerToken: 'stale-heartbeat-token',
      }),
      'utf8',
    );
    const expiredDate = new Date(Date.now() - 30_000);
    await utimes(lockPath, expiredDate, expiredDate);

    const result = await withFileLock(
      lockPath,
      async () => {
        const currentRecord = JSON.parse(await readFile(lockPath, 'utf8')) as {
          readonly ownerToken: string;
        };
        expect(currentRecord.ownerToken).not.toBe('stale-heartbeat-token');
        return 'reclaimed-ok';
      },
      { staleMs: 5_000, timeoutMs: 1_000, retryDelayMs: 5 },
    );

    expect(result).toBe('reclaimed-ok');
  });

  it('renews the lockfile mtime via the .unref()ed utimes heartbeat interval while the lease is held', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const lockPath = path.join(tempDir, 'heartbeat-renewal.lock');
    const lease = await acquireFileLock(lockPath, { heartbeatIntervalMs: 10 });
    try {
      const backdatedMs = Date.now() - 60_000;
      const backdatedDate = new Date(backdatedMs);
      await utimes(lockPath, backdatedDate, backdatedDate);
      const beforeHeartbeatStat = await stat(lockPath);
      expect(beforeHeartbeatStat.mtimeMs).toBeLessThanOrEqual(backdatedMs + 1_000);

      await vi.advanceTimersByTimeAsync(15);
      const afterHeartbeatStat = await stat(lockPath);
      expect(afterHeartbeatStat.mtimeMs).toBeGreaterThan(backdatedMs + 30_000);
    } finally {
      await lease.release();
    }
  });

  it('cancels queued waiters on AbortSignal without releasing an active critical-section slot early', async () => {
    const lockPath = path.join(tempDir, 'abort-signal.lock');
    const events: string[] = [];
    const holder1Entered = createDeferredLatch();
    const releaseHolder1 = createDeferredLatch();
    const holder1Controller = new AbortController();
    const waiter2Controller = new AbortController();
    const preAbortedController = new AbortController();
    preAbortedController.abort(new Error('already-aborted'));

    await expect(
      acquireFileLock(lockPath, { signal: preAbortedController.signal }),
    ).rejects.toThrowError('already-aborted');

    const holder1Promise = withFileLock(
      lockPath,
      async () => {
        events.push('holder-1-enter');
        holder1Entered.resolve();
        await releaseHolder1.promise;
        events.push('holder-1-exit');
        return 'holder-1-done';
      },
      { signal: holder1Controller.signal },
    );

    await holder1Entered.promise;

    const waiter2Promise = withFileLock(
      lockPath,
      async () => {
        events.push('waiter-2-enter');
        return 'waiter-2-done';
      },
      { signal: waiter2Controller.signal },
    );

    const waiter3Promise = withFileLock(lockPath, async () => {
      events.push('waiter-3-enter');
      events.push('waiter-3-exit');
      return 'waiter-3-done';
    });

    waiter2Controller.abort(new Error('waiter-2-cancelled'));
    await expect(waiter2Promise).rejects.toThrowError('waiter-2-cancelled');
    expect(events).toEqual(['holder-1-enter']);

    holder1Controller.abort(new Error('holder-1-post-entry-abort'));
    await Promise.resolve();
    expect(events).toEqual(['holder-1-enter']);

    releaseHolder1.resolve();
    const [res1, res3] = await Promise.all([holder1Promise, waiter3Promise]);
    expect(res1).toBe('holder-1-done');
    expect(res3).toBe('waiter-3-done');
    expect(events).toEqual(['holder-1-enter', 'holder-1-exit', 'waiter-3-enter', 'waiter-3-exit']);
  });

  it('times out when an active holder PID with a fresh heartbeat holds the lockfile beyond timeoutMs', async () => {
    const lockPath = path.join(tempDir, 'contended-live.lock');
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        acquiredAtMs: Date.now(),
        ownerToken: 'live-holder-token',
      }),
      'utf8',
    );

    await expect(
      acquireFileLock(lockPath, {
        timeoutMs: 25,
        staleMs: 60_000,
        retryDelayMs: 5,
      }),
    ).rejects.toThrowError(`Timed out after 25ms waiting for file lock '${path.resolve(lockPath)}'.`);
  });

  it('releases the lock in finally when work rejects and rejects empty lockPath inputs', async () => {
    const lockPath = path.join(tempDir, 'error-release.lock');

    await expect(acquireFileLock('   ')).rejects.toThrowError(
      'acquireFileLock requires a non-empty lockPath.',
    );

    await expect(
      withFileLock(lockPath, async () => {
        throw new Error('critical-section-failure');
      }),
    ).rejects.toThrowError('critical-section-failure');

    const followUp = await withFileLock(lockPath, async () => 'recovered');
    expect(followUp).toBe('recovered');
  });

  it('evicts the per-path PQueue from LOCK_PATH_QUEUES immediately upon lease release or acquisition timeout', async () => {
    const lockPath = path.join(tempDir, 'queue-eviction.lock');
    const resolvedLockPath = path.resolve(lockPath);

    const lease = await acquireFileLock(lockPath);
    expect(LOCK_PATH_QUEUES.has(resolvedLockPath)).toBe(true);
    await lease.release();
    expect(LOCK_PATH_QUEUES.has(resolvedLockPath)).toBe(false);

    const timeoutLockPath = path.join(tempDir, 'queue-timeout-eviction.lock');
    const resolvedTimeoutLockPath = path.resolve(timeoutLockPath);
    await writeFile(
      timeoutLockPath,
      JSON.stringify({
        pid: process.pid,
        acquiredAtMs: Date.now(),
        ownerToken: 'active-holder-token',
      }),
      'utf8',
    );

    await expect(
      acquireFileLock(timeoutLockPath, {
        timeoutMs: 20,
        staleMs: 60_000,
        retryDelayMs: 5,
      }),
    ).rejects.toThrowError(`Timed out after 20ms waiting for file lock '${resolvedTimeoutLockPath}'.`);
    expect(LOCK_PATH_QUEUES.has(resolvedTimeoutLockPath)).toBe(false);
  });

  it('preserves a replacement 0-byte or foreign-owner lockfile when a prior lease invokes release()', async () => {
    const zeroByteLockPath = path.join(tempDir, 'zero-byte-replacement.lock');
    const originalZeroByteLease = await acquireFileLock(zeroByteLockPath, {
      heartbeatIntervalMs: 60_000,
    });
    await writeFile(zeroByteLockPath, '', 'utf8');
    await originalZeroByteLease.release();

    const zeroByteStats = await stat(zeroByteLockPath);
    expect(zeroByteStats.size).toBe(0);

    const foreignOwnerLockPath = path.join(tempDir, 'foreign-owner-replacement.lock');
    const originalForeignLease = await acquireFileLock(foreignOwnerLockPath, {
      heartbeatIntervalMs: 60_000,
    });
    const foreignPayload = JSON.stringify({
      pid: process.pid,
      acquiredAtMs: Date.now(),
      ownerToken: 'foreign-owner-token',
    });
    await writeFile(foreignOwnerLockPath, foreignPayload, 'utf8');
    await originalForeignLease.release();

    const survivingContent = await readFile(foreignOwnerLockPath, 'utf8');
    expect(survivingContent).toBe(foreignPayload);
  });

  it('allows strictly one contender to win concurrent tryReclaimStaleLock calls without overwriting the winner', async () => {
    const staleLockPath = path.join(tempDir, 'concurrent-reclaim.lock');
    const resolvedStaleLockPath = path.resolve(staleLockPath);
    await writeFile(
      resolvedStaleLockPath,
      JSON.stringify({
        pid: 999_999_999,
        acquiredAtMs: Date.now() - 60_000,
        ownerToken: 'crashed-owner-token',
      }),
      'utf8',
    );

    const contenderARecord = JSON.stringify({
      pid: process.pid,
      acquiredAtMs: Date.now(),
      ownerToken: 'contender-a-token',
    });
    const contenderBRecord = JSON.stringify({
      pid: process.pid,
      acquiredAtMs: Date.now(),
      ownerToken: 'contender-b-token',
    });

    const [firstWon, secondWon] = await Promise.all([
      tryReclaimStaleLock(resolvedStaleLockPath, contenderARecord, 5_000),
      tryReclaimStaleLock(resolvedStaleLockPath, contenderBRecord, 5_000),
    ]);

    expect([firstWon, secondWon].sort()).toEqual([false, true]);
    const winningToken = firstWon ? 'contender-a-token' : 'contender-b-token';
    const persistedRecord = JSON.parse(await readFile(resolvedStaleLockPath, 'utf8')) as {
      readonly ownerToken: string;
    };
    expect(persistedRecord.ownerToken).toBe(winningToken);
  });
});
