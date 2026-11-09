import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryConfigSchema,
  MemorySessionEpochStateSchema,
  type MemoryConfig,
  type MemoryRecord,
} from '../src/index.js';
import { ensureMemoryGitCheckout } from '../src/internal/ensure-memory-git-checkout.js';
import { execGitCommand } from '../src/internal/exec-git-command.js';
import { createEmptyBranchLedgerState } from '../src/internal/git-checkout-helpers.js';
import { initializeMetaFromGitHistory } from '../src/internal/initialize-meta-from-git-history.js';
import { readMemoryLedger } from '../src/internal/read-memory-ledger.js';
import {
  applyIdRemapToRecordIds,
  composeCumulativeIdRemap,
  reconcileDivergedMemoryLedgers,
} from '../src/internal/reconcile-diverged-memory-ledgers.js';
import { remapOtherSessionStatesAfterLockRelease } from '../src/internal/remap-other-session-states-after-lock-release.js';
import { syncMemoryGit } from '../src/internal/sync-memory-git.js';
import { writeMemoryLedger } from '../src/internal/write-memory-ledger.js';

describe('Git checkout initialization, 3-way diverged ledger reconciliation & post-lock session state remapping', () => {
  let suiteRoot = '';
  let bareRemoteOne = '';
  let bareRemoteTwo = '';
  let bareCapRemote = '';
  let bareFailingHookRemote = '';
  let historyCheckoutDir = '';
  let attachWorkspaceRoot = '';
  let attachConfig: MemoryConfig;
  let pullWorkspaceRoot = '';
  let pullConfig: MemoryConfig;
  let unrelatedWorkspaceRoot = '';
  let unrelatedConfig: MemoryConfig;
  let pushWorkspaceBRoot = '';
  let pushConfigB: MemoryConfig;
  let capWorkspaceRoot = '';
  let capConfig: MemoryConfig;
  let capPreOpSnapshot = createEmptyBranchLedgerState();
  let failingPushWorkspaceRoot = '';
  let failingPushConfig: MemoryConfig;

  beforeAll(async () => {
    suiteRoot = await mkdtemp(path.join(os.tmpdir(), 'paraharness-memory-git-suite-'));
    bareRemoteOne = path.join(suiteRoot, 'remote-one.git');
    bareRemoteTwo = path.join(suiteRoot, 'remote-two.git');
    bareCapRemote = path.join(suiteRoot, 'remote-cap.git');
    bareFailingHookRemote = path.join(suiteRoot, 'remote-failing.git');

    await Promise.all([
      execGitCommand({
        cwd: suiteRoot,
        useDashC: false,
        args: ['init', '--bare', '-b', 'main', bareRemoteOne],
      }),
      execGitCommand({
        cwd: suiteRoot,
        useDashC: false,
        args: ['init', '--bare', '-b', 'main', bareRemoteTwo],
      }),
      execGitCommand({
        cwd: suiteRoot,
        useDashC: false,
        args: ['init', '--bare', '-b', 'main', bareCapRemote],
      }),
      execGitCommand({
        cwd: suiteRoot,
        useDashC: false,
        args: ['init', '--bare', '-b', 'main', bareFailingHookRemote],
      }),
    ]);

    const preReceiveHookPath = path.join(bareFailingHookRemote, 'hooks', 'pre-receive');
    await writeFile(preReceiveHookPath, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(preReceiveHookPath, 0o755);

    historyCheckoutDir = path.join(suiteRoot, 'history-repo');
    await mkdir(historyCheckoutDir, { recursive: true });
    await execGitCommand({
      cwd: historyCheckoutDir,
      useDashC: false,
      args: ['init', '-b', 'main', historyCheckoutDir],
    });
    const histLedger = path.join(historyCheckoutDir, 'memory.jsonl');
    const deletedRule: MemoryRecord = {
      id: 'R7',
      type: 'rule',
      role: 'general',
      text: 'Historical rule R7 later deleted',
      createdAt: '2026-11-09T09:00:00.000Z',
    };
    const survivingLesson: MemoryRecord = {
      id: 'L3',
      type: 'lesson',
      role: 'general',
      text: 'Do A when B, because C.',
      createdAt: '2026-11-09T09:05:00.000Z',
    };
    await writeFile(
      histLedger,
      `${JSON.stringify(deletedRule)}\n${JSON.stringify(survivingLesson)}\n`,
      'utf8',
    );
    await execGitCommand({ cwd: historyCheckoutDir, args: ['add', 'memory.jsonl'] });
    await execGitCommand({
      cwd: historyCheckoutDir,
      args: [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'seed R7 and L3',
      ],
    });
    await writeFile(histLedger, `${JSON.stringify(survivingLesson)}\n`, 'utf8');
    await execGitCommand({ cwd: historyCheckoutDir, args: ['add', 'memory.jsonl'] });
    await execGitCommand({
      cwd: historyCheckoutDir,
      args: [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'delete R7',
      ],
    });

    const seederOneRoot = path.join(suiteRoot, 'seeder-one');
    const seederOneConfig = MemoryConfigSchema.parse({
      repoId: 'seeder-one',
      allowedRoles: ['general', 'builder'],
      storage: {
        ledgerPath: '.memory/memory.jsonl',
        git: {
          enabled: true,
          checkoutDir: '.memory',
          remoteUrl: bareRemoteOne,
          branch: 'main',
          autoCommit: true,
          autoPush: true,
          autoPullOnInit: true,
        },
      },
    });
    await ensureMemoryGitCheckout({
      workspaceRoot: seederOneRoot,
      config: seederOneConfig,
    });
    await writeMemoryLedger({
      ledgerPath: path.join(seederOneRoot, '.memory', 'memory.jsonl'),
      records: [
        {
          id: 'L1',
          type: 'lesson',
          role: 'general',
          text: 'Remote lesson 1 on origin/main, because seeded first.',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
      ],
    });
    await syncMemoryGit({
      workspaceRoot: seederOneRoot,
      config: seederOneConfig,
      opSummary: 'seed L1 to remote-one',
    });

    attachWorkspaceRoot = path.join(suiteRoot, 'attach-ws');
    await mkdir(path.join(attachWorkspaceRoot, '.memory', '.session-state'), {
      recursive: true,
    });
    await writeFile(
      path.join(attachWorkspaceRoot, '.memory', '.session-state', 's1.json'),
      JSON.stringify({
        sessionId: 's1',
        role: 'builder',
        lastCompactionCheckpointId: 'epoch-0',
        seenRecordIds: ['L1'],
        lastScannedTranscriptOffset: 0,
        updatedAt: '2026-11-09T10:01:00.000Z',
      }),
      'utf8',
    );
    await writeMemoryLedger({
      ledgerPath: path.join(attachWorkspaceRoot, '.memory', 'memory.jsonl'),
      records: [
        {
          id: 'L1',
          type: 'lesson',
          role: 'builder',
          text: 'Pre-existing local lesson colliding with remote L1, because local existed before git init.',
          createdAt: '2026-11-09T10:02:00.000Z',
        },
      ],
    });
    attachConfig = MemoryConfigSchema.parse({
      repoId: 'attach-ws',
      allowedRoles: ['general', 'builder'],
      storage: {
        ledgerPath: '.memory/memory.jsonl',
        git: {
          enabled: true,
          checkoutDir: '.memory',
          remoteUrl: bareRemoteOne,
          branch: 'main',
          autoCommit: true,
          autoPush: false,
          autoPullOnInit: true,
        },
      },
    });

    pullWorkspaceRoot = path.join(suiteRoot, 'pull-ws');
    pullConfig = MemoryConfigSchema.parse({
      repoId: 'pull-ws',
      allowedRoles: ['general', 'builder'],
      storage: {
        ledgerPath: '.memory/memory.jsonl',
        git: {
          enabled: true,
          checkoutDir: '.memory',
          remoteUrl: bareRemoteTwo,
          branch: 'main',
          autoCommit: true,
          autoPush: true,
          autoPullOnInit: true,
        },
      },
    });
    await ensureMemoryGitCheckout({
      workspaceRoot: pullWorkspaceRoot,
      config: pullConfig,
    });
    await writeMemoryLedger({
      ledgerPath: path.join(pullWorkspaceRoot, '.memory', 'memory.jsonl'),
      records: [
        {
          id: 'R1',
          type: 'rule',
          role: 'general',
          text: 'Base rule R1',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
      ],
    });
    await syncMemoryGit({
      workspaceRoot: pullWorkspaceRoot,
      config: pullConfig,
      opSummary: 'seed R1',
    });

    pushWorkspaceBRoot = path.join(suiteRoot, 'push-ws-b');
    pushConfigB = MemoryConfigSchema.parse({
      repoId: 'push-ws-b',
      allowedRoles: ['general', 'builder'],
      storage: {
        ledgerPath: '.memory/memory.jsonl',
        git: {
          enabled: true,
          checkoutDir: '.memory',
          remoteUrl: bareRemoteTwo,
          branch: 'main',
          autoCommit: true,
          autoPush: true,
          autoPullOnInit: true,
        },
      },
    });
    await ensureMemoryGitCheckout({
      workspaceRoot: pushWorkspaceBRoot,
      config: pushConfigB,
    });

    await writeMemoryLedger({
      ledgerPath: path.join(pullWorkspaceRoot, '.memory', 'memory.jsonl'),
      records: [
        {
          id: 'R1',
          type: 'rule',
          role: 'general',
          text: 'Base rule R1',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
        {
          id: 'L1',
          type: 'lesson',
          role: 'general',
          text: 'Remote lesson L1 pushed by pull-ws, because remote advanced.',
          createdAt: '2026-11-09T10:05:00.000Z',
        },
      ],
    });
    await syncMemoryGit({
      workspaceRoot: pullWorkspaceRoot,
      config: pullConfig,
      opSummary: 'add L1 on remote-two',
    });

    unrelatedWorkspaceRoot = path.join(suiteRoot, 'unrelated-ws');
    unrelatedConfig = MemoryConfigSchema.parse({
      repoId: 'unrelated-ws',
      allowedRoles: ['general'],
      storage: {
        ledgerPath: '.memory/memory.jsonl',
        git: {
          enabled: true,
          checkoutDir: '.memory',
          branch: 'main',
          autoCommit: true,
          autoPush: false,
          autoPullOnInit: true,
        },
      },
    });
    await ensureMemoryGitCheckout({
      workspaceRoot: unrelatedWorkspaceRoot,
      config: unrelatedConfig,
    });
    await writeMemoryLedger({
      ledgerPath: path.join(unrelatedWorkspaceRoot, '.memory', 'memory.jsonl'),
      records: [
        {
          id: 'N1',
          type: 'note',
          role: 'general',
          text: 'Unrelated local history note N1',
          createdAt: '2026-11-09T10:06:00.000Z',
          lifecycle: { mode: 'persistent' },
        },
      ],
    });
    await syncMemoryGit({
      workspaceRoot: unrelatedWorkspaceRoot,
      config: unrelatedConfig,
      opSummary: 'local commit on unrelated root',
    });
    unrelatedConfig = MemoryConfigSchema.parse({
      repoId: 'unrelated-ws',
      allowedRoles: ['general'],
      storage: {
        ledgerPath: '.memory/memory.jsonl',
        git: {
          enabled: true,
          checkoutDir: '.memory',
          remoteUrl: bareRemoteTwo,
          branch: 'main',
          autoCommit: true,
          autoPush: false,
          autoPullOnInit: true,
        },
      },
    });

    const capSeederRoot = path.join(suiteRoot, 'cap-seeder');
    const capSeederConfig = MemoryConfigSchema.parse({
      repoId: 'cap-repo',
      allowedRoles: ['general'],
      caps: [{ roles: ['general'], paths: [], types: ['lesson'], softCap: 1, hardCap: 1 }],
      storage: {
        ledgerPath: '.memory/memory.jsonl',
        git: {
          enabled: true,
          checkoutDir: '.memory',
          remoteUrl: bareCapRemote,
          branch: 'main',
          autoCommit: true,
          autoPush: true,
          autoPullOnInit: true,
        },
      },
    });
    await ensureMemoryGitCheckout({
      workspaceRoot: capSeederRoot,
      config: capSeederConfig,
    });
    await writeMemoryLedger({
      ledgerPath: path.join(capSeederRoot, '.memory', 'memory.jsonl'),
      records: [
        {
          id: 'R1',
          type: 'rule',
          role: 'general',
          text: 'Initial rule R1',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
      ],
    });
    await syncMemoryGit({
      workspaceRoot: capSeederRoot,
      config: capSeederConfig,
      opSummary: 'seed R1',
    });

    capWorkspaceRoot = path.join(suiteRoot, 'cap-contender');
    capConfig = capSeederConfig;
    await ensureMemoryGitCheckout({
      workspaceRoot: capWorkspaceRoot,
      config: capConfig,
    });
    const preOpNote: MemoryRecord = {
      id: 'N1',
      type: 'note',
      role: 'general',
      text: 'Unpushed local note N1 that must survive CAP_EXCEEDED rollback',
      createdAt: '2026-11-09T10:01:00.000Z',
      lifecycle: { mode: 'persistent' },
    };
    const preOpWritten = await writeMemoryLedger({
      ledgerPath: path.join(capWorkspaceRoot, '.memory', 'memory.jsonl'),
      records: [
        {
          id: 'R1',
          type: 'rule',
          role: 'general',
          text: 'Initial rule R1',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
        preOpNote,
      ],
    });
    capPreOpSnapshot = {
      records: preOpWritten.records,
      meta: preOpWritten.meta,
    };

    await writeMemoryLedger({
      ledgerPath: path.join(capSeederRoot, '.memory', 'memory.jsonl'),
      records: [
        {
          id: 'R1',
          type: 'rule',
          role: 'general',
          text: 'Initial rule R1',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
        {
          id: 'L1',
          type: 'lesson',
          role: 'general',
          text: 'Remote lesson filling hardCap=1, because seeder pushed first.',
          createdAt: '2026-11-09T10:02:00.000Z',
        },
      ],
    });
    await syncMemoryGit({
      workspaceRoot: capSeederRoot,
      config: capSeederConfig,
      opSummary: 'push L1 filling cap',
    });

    failingPushWorkspaceRoot = path.join(suiteRoot, 'failing-push-ws');
    failingPushConfig = MemoryConfigSchema.parse({
      repoId: 'failing-push-ws',
      allowedRoles: ['general'],
      storage: {
        ledgerPath: '.memory/memory.jsonl',
        git: {
          enabled: true,
          checkoutDir: '.memory',
          remoteUrl: bareFailingHookRemote,
          branch: 'main',
          autoCommit: true,
          autoPush: true,
          autoPullOnInit: true,
        },
      },
    });
    await ensureMemoryGitCheckout({
      workspaceRoot: failingPushWorkspaceRoot,
      config: failingPushConfig,
    });
  });

  afterAll(async () => {
    if (suiteRoot.length > 0) {
      await rm(suiteRoot, { recursive: true, force: true });
    }
  });

  it('recovers high-water marks of deleted records from git log -p -S via initializeMetaFromGitHistory (§3.1)', async () => {
    const recoveredMeta = await initializeMetaFromGitHistory(
      path.join(historyCheckoutDir, 'memory.jsonl'),
    );
    expect(recoveredMeta).toEqual({
      schemaVersion: 1,
      highWaterMarks: {
        R: 7,
        L: 3,
        N: 0,
      },
    });
  });

  it('performs pure 3-way record merge, monotonic ID collision re-numbering, read-count delta subtraction, timestamp tie-breaking, and transitive cumulativeIdRemap composition (§8.2.3)', () => {
    const base = {
      meta: {
        schemaVersion: 1 as const,
        highWaterMarks: { R: 1, L: 1, N: 2 },
      },
      records: [
        {
          id: 'R1',
          type: 'rule' as const,
          role: 'general',
          text: 'Base R1',
          createdAt: '2026-11-09T09:00:00.000Z',
        },
        {
          id: 'L1',
          type: 'lesson' as const,
          role: 'general',
          text: 'Base L1 deleted in local, unmodified in remote',
          createdAt: '2026-11-09T09:00:00.000Z',
        },
        {
          id: 'N1',
          type: 'note' as const,
          role: 'general',
          text: 'Read-count note starting at 4 reads',
          createdAt: '2026-11-09T09:00:00.000Z',
          lifecycle: { mode: 'read-count' as const, remainingReads: 4 },
        },
        {
          id: 'N2',
          type: 'note' as const,
          role: 'general',
          text: 'Read-count note that drains to 0 across branches',
          createdAt: '2026-11-09T09:00:00.000Z',
          lifecycle: { mode: 'read-count' as const, remainingReads: 2 },
        },
      ],
    };

    const local = {
      meta: {
        schemaVersion: 1 as const,
        highWaterMarks: { R: 1, L: 2, N: 2 },
      },
      records: [
        {
          id: 'R1',
          type: 'rule' as const,
          role: 'general',
          text: 'Local R1 wins exact millisecond tie',
          createdAt: '2026-11-09T09:00:00.000Z',
          updatedAt: '2026-11-09T10:00:00.000Z',
        },
        {
          id: 'L2',
          type: 'lesson' as const,
          role: 'builder',
          text: 'Newly added local lesson at L2 colliding with remote L2',
          createdAt: '2026-11-09T10:01:00.000Z',
        },
        {
          id: 'N1',
          type: 'note' as const,
          role: 'general',
          text: 'Read-count note starting at 4 reads',
          createdAt: '2026-11-09T09:00:00.000Z',
          lifecycle: { mode: 'read-count' as const, remainingReads: 3 },
        },
        {
          id: 'N2',
          type: 'note' as const,
          role: 'general',
          text: 'Read-count note that drains to 0 across branches',
          createdAt: '2026-11-09T09:00:00.000Z',
          lifecycle: { mode: 'read-count' as const, remainingReads: 1 },
        },
      ],
    };

    const remote = {
      meta: {
        schemaVersion: 1 as const,
        highWaterMarks: { R: 1, L: 3, N: 2 },
      },
      records: [
        {
          id: 'R1',
          type: 'rule' as const,
          role: 'general',
          text: 'Remote R1 loses exact millisecond tie',
          createdAt: '2026-11-09T09:00:00.000Z',
          updatedAt: '2026-11-09T10:00:00.000Z',
        },
        {
          id: 'L1',
          type: 'lesson' as const,
          role: 'general',
          text: 'Base L1 deleted in local, unmodified in remote',
          createdAt: '2026-11-09T09:00:00.000Z',
        },
        {
          id: 'L2',
          type: 'lesson' as const,
          role: 'general',
          text: 'Remote L2 kept at original ID L2',
          createdAt: '2026-11-09T10:00:30.000Z',
        },
        {
          id: 'N1',
          type: 'note' as const,
          role: 'general',
          text: 'Read-count note starting at 4 reads',
          createdAt: '2026-11-09T09:00:00.000Z',
          lifecycle: { mode: 'read-count' as const, remainingReads: 2 },
        },
        {
          id: 'N2',
          type: 'note' as const,
          role: 'general',
          text: 'Read-count note that drains to 0 across branches',
          createdAt: '2026-11-09T09:00:00.000Z',
          lifecycle: { mode: 'read-count' as const, remainingReads: 1 },
        },
      ],
    };

    const reconciled = reconcileDivergedMemoryLedgers(base, local, remote);
    expect(Object.fromEntries(reconciled.idRemap)).toEqual({ L2: 'L4' });
    expect(reconciled.meta.highWaterMarks).toEqual({ R: 1, L: 4, N: 2 });
    expect(reconciled.records.map((r) => r.id)).toEqual(['R1', 'L2', 'L4', 'N1']);
    expect(reconciled.records.find((r) => r.id === 'R1')?.text).toBe(
      'Local R1 wins exact millisecond tie',
    );
    expect(reconciled.records.find((r) => r.id === 'L2')?.text).toBe(
      'Remote L2 kept at original ID L2',
    );
    expect(reconciled.records.find((r) => r.id === 'L4')?.text).toBe(
      'Newly added local lesson at L2 colliding with remote L2',
    );
    const mergedN1 = reconciled.records.find((r) => r.id === 'N1');
    expect(mergedN1?.type === 'note' ? mergedN1.lifecycle : null).toEqual({
      mode: 'read-count',
      remainingReads: 1,
    });

    const cumulative = new Map<string, string>([['L2', 'L4']]);
    composeCumulativeIdRemap(
      cumulative,
      new Map<string, string>([
        ['L4', 'L5'],
        ['N9', 'N10'],
      ]),
    );
    expect(Object.fromEntries(cumulative)).toEqual({
      L2: 'L5',
      N9: 'N10',
    });
    expect(applyIdRemapToRecordIds(['R1', 'L2', 'N9'], cumulative)).toEqual(['R1', 'L5', 'N10']);
  });

  it('initializes .memory git checkout in-place with .gitignore entries, preserves .session-state/, reconciles pre-existing local memory.jsonl against origin/main, and remaps <otherSid>.json after lock release', async () => {
    const res = await ensureMemoryGitCheckout({
      workspaceRoot: attachWorkspaceRoot,
      config: attachConfig,
    });
    expect(res.initializedNewGitRepo).toBe(true);
    expect(res.reconciledWithRemote).toBe(true);
    expect(res.gitCommitted).toBe(true);
    expect(Object.fromEntries(res.cumulativeIdRemap)).toEqual({ L1: 'L2' });

    const gitignoreText = await readFile(
      path.join(attachWorkspaceRoot, '.memory', '.gitignore'),
      'utf8',
    );
    expect(gitignoreText).toContain('.session-state/');
    expect(gitignoreText).toContain('*.lock');
    expect(gitignoreText).toContain('*.tmp*');

    const snap = await readMemoryLedger(
      path.join(attachWorkspaceRoot, '.memory', 'memory.jsonl'),
    );
    expect(snap.records.map((r) => r.id)).toEqual(['L1', 'L2']);

    const remappedSids = await remapOtherSessionStatesAfterLockRelease(
      attachWorkspaceRoot,
      res.cumulativeIdRemap,
    );
    expect(remappedSids).toEqual(['s1']);
    const s1Raw = await readFile(
      path.join(attachWorkspaceRoot, '.memory', '.session-state', 's1.json'),
      'utf8',
    );
    const s1State = MemorySessionEpochStateSchema.parse(JSON.parse(s1Raw));
    expect(s1State.seenRecordIds).toEqual(['L2']);
  });

  it('handles autoPullOnInit negative/edge paths (autoPullOnInit=false, remoteUrl=undefined, already-ancestor, offline fetch fallback, unrelated histories merge-base exit 1, and clean status skipping commit)', async () => {
    const noPullCfg = MemoryConfigSchema.parse({
      ...pullConfig,
      storage: {
        ...pullConfig.storage,
        git: {
          ...pullConfig.storage.git,
          autoPullOnInit: false,
        },
      },
    });
    const skippedPull = await ensureMemoryGitCheckout({
      workspaceRoot: pullWorkspaceRoot,
      config: noPullCfg,
      isInitCall: true,
    });
    expect(skippedPull.reconciledWithRemote).toBe(false);

    const noRemoteCfg = MemoryConfigSchema.parse({
      ...pullConfig,
      storage: {
        ...pullConfig.storage,
        git: {
          enabled: true,
          checkoutDir: '.memory',
          branch: 'main',
          autoCommit: true,
          autoPush: false,
          autoPullOnInit: true,
        },
      },
    });
    const skippedNoRemote = await ensureMemoryGitCheckout({
      workspaceRoot: pullWorkspaceRoot,
      config: noRemoteCfg,
      isInitCall: true,
    });
    expect(skippedNoRemote.reconciledWithRemote).toBe(false);

    const alreadyAncestor = await ensureMemoryGitCheckout({
      workspaceRoot: pullWorkspaceRoot,
      config: pullConfig,
      isInitCall: true,
    });
    expect(alreadyAncestor.reconciledWithRemote).toBe(false);

    const cleanCommit = await syncMemoryGit({
      workspaceRoot: pullWorkspaceRoot,
      config: noRemoteCfg,
      opSummary: 'no-op clean tree',
    });
    expect(cleanCommit.gitCommitted).toBe(false);

    const offlineCfg = MemoryConfigSchema.parse({
      ...pullConfig,
      storage: {
        ...pullConfig.storage,
        git: {
          ...pullConfig.storage.git,
          remoteUrl: path.join(suiteRoot, 'nonexistent-offline-remote.git'),
          autoPush: false,
        },
      },
    });
    const offlineFallback = await ensureMemoryGitCheckout({
      workspaceRoot: pullWorkspaceRoot,
      config: offlineCfg,
      isInitCall: true,
    });
    expect(offlineFallback.reconciledWithRemote).toBe(false);

    const unrelatedPull = await ensureMemoryGitCheckout({
      workspaceRoot: unrelatedWorkspaceRoot,
      config: unrelatedConfig,
      isInitCall: true,
    });
    expect(unrelatedPull.reconciledWithRemote).toBe(true);
    const unrelatedSnap = await readMemoryLedger(
      path.join(unrelatedWorkspaceRoot, '.memory', 'memory.jsonl'),
    );
    expect(unrelatedSnap.records.map((r) => r.id)).toEqual(['R1', 'L1', 'N1']);
  });

  it('reconciles concurrent diverged multi-repo autoPush with fallback author identity and re-numbers colliding local additions', async () => {
    await writeMemoryLedger({
      ledgerPath: path.join(pushWorkspaceBRoot, '.memory', 'memory.jsonl'),
      records: [
        {
          id: 'R1',
          type: 'rule',
          role: 'general',
          text: 'Base rule R1',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
        {
          id: 'L1',
          type: 'lesson',
          role: 'builder',
          text: 'Concurrent local lesson L1 on push-ws-b, because pushed after pull-ws.',
          createdAt: '2026-11-09T10:07:00.000Z',
        },
      ],
    });
    const pushRes = await syncMemoryGit({
      workspaceRoot: pushWorkspaceBRoot,
      config: pushConfigB,
      opSummary: 'concurrent add L1 from repo B',
    });
    expect(pushRes.gitCommitted).toBe(true);
    expect(pushRes.gitPushed).toBe(true);
    expect(Object.fromEntries(pushRes.cumulativeIdRemap)).toEqual({ L1: 'L2' });
    expect(pushRes.records.map((r) => r.id)).toEqual(['R1', 'L1', 'L2']);

    const logAuthor = await execGitCommand({
      cwd: path.join(pushWorkspaceBRoot, '.memory'),
      args: ['log', '-1', '--format=%an <%ae>'],
    });
    expect(logAuthor.stdout.trim()).toBe('paraharness-memory <memory@paraharness.local>');
  });

  it('rolls back to reconciled pre-operation state when post-push 3-way reconciliation exceeds hardCap (CAP_EXCEEDED) and throws GIT_SYNC_FAILED on unreachable ls-remote or 3 failed push retries', async () => {
    await writeMemoryLedger({
      ledgerPath: path.join(capWorkspaceRoot, '.memory', 'memory.jsonl'),
      records: [
        ...capPreOpSnapshot.records,
        {
          id: 'L1',
          type: 'lesson',
          role: 'general',
          text: 'Local lesson L1 exceeding hardCap=1 after remote L1 merge, because cap is 1.',
          createdAt: '2026-11-09T10:03:00.000Z',
        },
      ],
    });

    await expect(
      syncMemoryGit({
        workspaceRoot: capWorkspaceRoot,
        config: capConfig,
        opSummary: 'attempt add L1 over cap',
        preOpSnapshot: capPreOpSnapshot,
        capCheckCandidate: {
          type: 'lesson',
          role: 'general',
        },
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));

    const rolledBackSnap = await readMemoryLedger(
      path.join(capWorkspaceRoot, '.memory', 'memory.jsonl'),
    );
    expect(rolledBackSnap.records.map((r) => r.id)).toEqual(['R1', 'L1', 'N1']);
    expect(rolledBackSnap.records.find((r) => r.id === 'L1')?.text).toContain(
      'Remote lesson filling hardCap=1',
    );
    expect(rolledBackSnap.records.find((r) => r.id === 'N1')?.text).toContain(
      'Unpushed local note N1 that must survive CAP_EXCEEDED rollback',
    );

    const unreachableWs = path.join(suiteRoot, 'unreachable-init-ws');
    const unreachableCfg = MemoryConfigSchema.parse({
      repoId: 'unreachable',
      allowedRoles: ['general'],
      storage: {
        ledgerPath: '.memory/memory.jsonl',
        git: {
          enabled: true,
          checkoutDir: '.memory',
          remoteUrl: path.join(suiteRoot, 'does-not-exist.git'),
          branch: 'main',
          autoCommit: true,
          autoPush: false,
          autoPullOnInit: true,
        },
      },
    });
    await expect(
      ensureMemoryGitCheckout({
        workspaceRoot: unreachableWs,
        config: unreachableCfg,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'GIT_SYNC_FAILED' }));

    await writeMemoryLedger({
      ledgerPath: path.join(failingPushWorkspaceRoot, '.memory', 'memory.jsonl'),
      records: [
        {
          id: 'R1',
          type: 'rule',
          role: 'general',
          text: 'Rule triggering 3 failed push retries',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
      ],
    });
    await expect(
      syncMemoryGit({
        workspaceRoot: failingPushWorkspaceRoot,
        config: failingPushConfig,
        opSummary: 'push against rejecting hook',
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'GIT_SYNC_FAILED' }));
  });
});
