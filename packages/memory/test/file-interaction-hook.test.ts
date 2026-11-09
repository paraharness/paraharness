import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from '@paraharness/lockfile';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryHarness,
  MemorySessionEpochStateSchema,
} from '../src/index.js';
import { execGitCommand } from '../src/internal/exec-git-command.js';
import { createTempMemoryWorkspace } from './fixtures/create-temp-memory-workspace.js';
import type { TempMemoryWorkspaceHandle } from './fixtures/temp-memory-workspace-handle.js';

const SCOPED_LESSON =
  'Pass a queued-wait-only AbortController signal to PQueue.add before critical work, because p-queue releases the slot on mid-task abort.';

describe('MemoryHarness.handleFileInteractionHook end-to-end compaction epoch & lifecycle suite', () => {
  const activeWorkspaces: TempMemoryWorkspaceHandle[] = [];
  const extraTempDirs: string[] = [];

  afterEach(async () => {
    while (activeWorkspaces.length > 0) {
      const ws = activeWorkspaces.pop();
      if (ws !== undefined) {
        await ws.cleanup();
      }
    }
    while (extraTempDirs.length > 0) {
      const dir = extraTempDirs.pop();
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('verifies INVALID_ROLE, external-path early exit without acquiring <ledgerPath>.lock, PENDING_HOOK_EPOCH preservation of post-init seenRecordIds, and unseen-only note lifecycle drainage', async () => {
    const ws = await createTempMemoryWorkspace({
      files: {
        'packages/lockfile/src/index.ts': 'export const lock = true;\n',
        'packages/sqlite/src/index.ts': 'export const db = true;\n',
      },
    });
    activeWorkspaces.push(ws);

    const harness = new MemoryHarness({ workspaceRoot: ws.workspaceRoot });

    await expect(
      harness.handleFileInteractionHook({
        sessionId: 'sess-hook-1',
        role: 'invalid-role',
        touchedPaths: ['packages/lockfile/src/index.ts'],
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'INVALID_ROLE',
      }),
    );

    await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'rule',
      role: 'general',
      text: 'Scoped lockfile rule R1.',
      context: ['packages/lockfile/**'],
    });
    await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: SCOPED_LESSON,
      context: ['packages/lockfile/**'],
    });
    await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'note',
      role: 'builder',
      text: 'Scopedsqlite read-count note N1.',
      context: ['packages/sqlite/**'],
      lifecycle: { mode: 'read-count', remainingReads: 2 },
    });

    await harness.init({ role: 'builder', sessionId: 'sess-hook-1' });
    await harness.loadScoped({
      role: 'builder',
      paths: ['packages/lockfile/src/index.ts'],
      sessionId: 'sess-hook-1',
    });

    const externalExitWhileLedgerLocked = await withFileLock(
      `${ws.ledgerPath}.lock`,
      async () => {
        return await harness.handleFileInteractionHook({
          sessionId: 'sess-hook-1',
          touchedPaths: ['/etc/hosts', '../outside-repo/file.ts'],
        });
      },
    );
    expect(externalExitWhileLedgerLocked).toEqual({
      injected: false,
      compactionEpochId: 'epoch-0',
      formattedContext: null,
      rules: [],
      lessons: [],
      notes: [],
    });

    const stateAfterExternal = MemorySessionEpochStateSchema.parse(
      JSON.parse(await readFile(path.join(ws.sessionStateDir, 'sess-hook-1.json'), 'utf8')),
    );
    expect(stateAfterExternal.lastCompactionCheckpointId).toBe('epoch-0');
    expect(stateAfterExternal.seenRecordIds).toEqual(['R1', 'L1']);

    const alreadySeenHook = await harness.handleFileInteractionHook({
      sessionId: 'sess-hook-1',
      touchedPaths: ['packages/lockfile/src/index.ts'],
    });
    expect(alreadySeenHook.injected).toBe(false);

    const firstSqliteTouch = await harness.handleFileInteractionHook({
      sessionId: 'sess-hook-1',
      touchedPaths: ['packages/sqlite/src/index.ts'],
    });
    expect(firstSqliteTouch.injected).toBe(true);
    expect(firstSqliteTouch.notes.map((n) => ({
      id: n.id,
      remainingReads: n.lifecycle.mode === 'read-count' ? n.lifecycle.remainingReads : -1,
      drainedOnThisRead: n.drainedOnThisRead,
    }))).toEqual([
      {
        id: 'N1',
        remainingReads: 1,
        drainedOnThisRead: false,
      },
    ]);

    const suppressedSqliteTouch = await harness.handleFileInteractionHook({
      sessionId: 'sess-hook-1',
      touchedPaths: ['packages/sqlite/src/index.ts'],
    });
    expect(suppressedSqliteTouch.injected).toBe(false);

    const manualCheckAfterSuppressed = await harness.loadScoped({
      role: 'builder',
      paths: ['packages/sqlite/src/index.ts'],
    });
    expect(manualCheckAfterSuppressed.notes.map((n) => ({
      id: n.id,
      drainedOnThisRead: n.drainedOnThisRead,
      renderedText: n.renderedText,
    }))).toEqual([
      {
        id: 'N1',
        drainedOnThisRead: true,
        renderedText: '[FINAL READ - DRAINED] Scopedsqlite read-count note N1.',
      },
    ]);
  });

  it('verifies Antigravity transcript tool-step path extraction, incremental compaction-boundary reset, and 5-tier role fallback precedence', async () => {
    const ws = await createTempMemoryWorkspace({
      files: {
        'packages/memory/src/index.ts': 'export {};\n',
      },
    });
    activeWorkspaces.push(ws);

    const harness = new MemoryHarness({ workspaceRoot: ws.workspaceRoot });

    await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'reviewer',
      text: SCOPED_LESSON,
      context: ['packages/memory/**'],
    });

    const transcriptRelPath = 'transcript.jsonl';
    await ws.writeWorkspaceFile(
      transcriptRelPath,
      [
        JSON.stringify({
          tool_name: 'mcp__memory__memory_init',
          tool_input: { role: 'reviewer' },
        }),
        JSON.stringify({
          tool_name: 'view_file',
          tool_input: {
            AbsolutePath: path.join(ws.workspaceRoot, 'packages/memory/src/index.ts'),
          },
        }),
      ].join('\n') + '\n',
    );

    const firstHook = await harness.handleFileInteractionHook({
      sessionId: 'sess-transcript',
      transcriptPath: transcriptRelPath,
      touchedPaths: ['/outside/ignored-because-transcript-has-view_file'],
    });
    expect(firstHook.injected).toBe(true);
    expect(firstHook.compactionEpochId).toBe('epoch-0');
    expect(firstHook.lessons.map((l) => l.id)).toEqual(['L1']);
    expect(firstHook.formattedContext).toContain('L1');

    const secondHookSameEpoch = await harness.handleFileInteractionHook({
      sessionId: 'sess-transcript',
      transcriptPath: transcriptRelPath,
      touchedPaths: ['packages/memory/src/index.ts'],
    });
    expect(secondHookSameEpoch.injected).toBe(false);

    const existingTranscript = await readFile(
      path.join(ws.workspaceRoot, transcriptRelPath),
      'utf8',
    );
    await ws.writeWorkspaceFile(
      transcriptRelPath,
      existingTranscript +
        [
          JSON.stringify({
            type: 'CHECKPOINT',
            step_index: 42,
          }),
          JSON.stringify({
            tool_name: 'grep_search',
            tool_input: {
              SearchPath: 'packages/memory',
              Includes: ['*.ts'],
              Query: 'MemoryHarness',
            },
          }),
        ].join('\n') +
        '\n',
    );

    const thirdHookAfterCheckpoint = await harness.handleFileInteractionHook({
      sessionId: 'sess-transcript',
      transcriptPath: transcriptRelPath,
      touchedPaths: ['/outside/ignored'],
    });
    expect(thirdHookAfterCheckpoint.injected).toBe(true);
    expect(thirdHookAfterCheckpoint.compactionEpochId).toBe('42');
    expect(thirdHookAfterCheckpoint.lessons.map((l) => l.id)).toEqual(['L1']);

    await harness.init({ role: 'reviewer', sessionId: 'sess-init-writer' });
    const latestRoleFallbackHook = await harness.handleFileInteractionHook({
      sessionId: 'sess-fallback-latest-role',
      touchedPaths: ['packages/memory/src/index.ts'],
    });
    expect(latestRoleFallbackHook.injected).toBe(true);
    expect(latestRoleFallbackHook.lessons.map((l) => l.id)).toEqual(['L1']);
  });

  it('verifies post-reconcile cumulativeIdRemap propagation to caller state.seenRecordIds and other session state files during hook Git push', async () => {
    const bareRemoteDir = await mkdtemp(path.join(os.tmpdir(), 'paraharness-hook-remap-bare-'));
    extraTempDirs.push(bareRemoteDir);
    await execGitCommand({
      cwd: bareRemoteDir,
      useDashC: false,
      args: ['init', '--bare', '-b', 'main', bareRemoteDir],
    });

    const gitConfig = {
      repoId: 'repo-hook-git',
      allowedRoles: ['general', 'builder'],
      storage: {
        ledgerPath: '.memory/memory.jsonl',
        git: {
          enabled: true,
          checkoutDir: '.memory',
          remoteUrl: bareRemoteDir,
          branch: 'main',
          autoCommit: true,
          autoPush: true,
          autoPullOnInit: true,
        },
      },
    };

    const wsRemote = await createTempMemoryWorkspace({
      config: gitConfig,
      files: {
        'packages/a/file.ts': 'export const a = 1;\n',
      },
    });
    const wsLocal = await createTempMemoryWorkspace({
      config: {
        ...gitConfig,
        storage: {
          ledgerPath: '.memory/memory.jsonl',
          git: {
            ...gitConfig.storage.git,
            autoPush: false,
          },
        },
      },
      files: {
        'packages/a/file.ts': 'export const a = 1;\n',
      },
    });
    activeWorkspaces.push(wsRemote, wsLocal);

    const harnessRemote = new MemoryHarness({ workspaceRoot: wsRemote.workspaceRoot });
    const harnessLocal = new MemoryHarness({ workspaceRoot: wsLocal.workspaceRoot });

    await harnessRemote.init({ role: 'builder', sessionId: 's-remote' });
    await harnessLocal.init({ role: 'builder', sessionId: 's-local' });

    await harnessRemote.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'note',
      role: 'builder',
      text: 'Remote note N1.',
      context: ['packages/a/**'],
      lifecycle: { mode: 'persistent' },
    });

    await harnessLocal.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'note',
      role: 'builder',
      text: 'Local read-count note initially allocated as N1 before push reconcile.',
      context: ['packages/a/**'],
      lifecycle: { mode: 'read-count', remainingReads: 2 },
    });

    await mkdir(wsLocal.sessionStateDir, { recursive: true });
    await writeFile(
      path.join(wsLocal.sessionStateDir, 'other-session.json'),
      JSON.stringify({
        sessionId: 'other-session',
        role: 'builder',
        lastCompactionCheckpointId: 'epoch-0',
        seenRecordIds: ['N1'],
        lastScannedTranscriptOffset: 0,
        updatedAt: '2026-11-09T12:00:00.000Z',
      }),
      'utf8',
    );

    await wsLocal.writeConfig(gitConfig);

    const hookOut = await harnessLocal.handleFileInteractionHook({
      sessionId: 's-local',
      role: 'builder',
      touchedPaths: ['packages/a/file.ts'],
    });
    expect(hookOut.injected).toBe(true);
    expect(hookOut.notes.map((n) => n.id)).toEqual(['N2']);

    const callerSession = MemorySessionEpochStateSchema.parse(
      JSON.parse(await readFile(path.join(wsLocal.sessionStateDir, 's-local.json'), 'utf8')),
    );
    expect(callerSession.seenRecordIds).toEqual(['N2']);

    const otherSession = MemorySessionEpochStateSchema.parse(
      JSON.parse(await readFile(path.join(wsLocal.sessionStateDir, 'other-session.json'), 'utf8')),
    );
    expect(otherSession.seenRecordIds).toEqual(['N2']);

    const secondHookOut = await harnessLocal.handleFileInteractionHook({
      sessionId: 's-local',
      role: 'builder',
      touchedPaths: ['packages/a/file.ts'],
    });
    expect(secondHookOut.injected).toBe(true);
    expect(secondHookOut.notes.map((n) => n.id)).toEqual(['N1']);
  });
});
