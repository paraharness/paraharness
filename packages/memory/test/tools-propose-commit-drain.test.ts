import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from '@paraharness/lockfile';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClaudeCliDistillerRunner,
  MemoryHarness,
  MemoryLatestRoleStateSchema,
  MemorySessionEpochStateSchema,
} from '../src/index.js';
import { execGitCommand } from '../src/internal/exec-git-command.js';
import { createTempMemoryWorkspace } from './fixtures/create-temp-memory-workspace.js';
import { FakeMemoryDistillerRunner } from './fixtures/fake-memory-distiller-runner.js';
import type { TempMemoryWorkspaceHandle } from './fixtures/temp-memory-workspace-handle.js';

const VALID_LESSON_ONE =
  'Detach the caller AbortSignal listener inside the task callback before running critical work, because p-queue settles early on abort.';
const VALID_LESSON_TWO =
  'Normalize incoming stream data chunks to Buffer before passing to ReadBuffer, because subarray is undefined on string chunks.';
const VALID_LESSON_MERGED =
  'Detach AbortSignal listeners and normalize incoming stream chunks to Buffer before critical execution, because premature aborts and string chunks corrupt state.';

describe('MemoryHarness tools (getConfig, init, loadScoped, propose, commit, drainNotes) & ClaudeCliDistillerRunner', () => {
  const activeWorkspaces: TempMemoryWorkspaceHandle[] = [];
  const extraTempDirs: string[] = [];

  afterEach(async () => {
    delete process.env['CLAUDE_SESSION_ID'];
    delete process.env['AGY_SESSION_ID'];
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

  it('verifies getConfig() synchronous discovery, explicit configPath override, and CONFIG_NOT_FOUND', async () => {
    const ws = await createTempMemoryWorkspace({ config: null });
    activeWorkspaces.push(ws);

    const missingHarness = new MemoryHarness({ workspaceRoot: ws.workspaceRoot });
    expect(() => missingHarness.getConfig()).toThrowError(
      expect.objectContaining({
        name: 'MemoryHarnessError',
        code: 'CONFIG_NOT_FOUND',
      }),
    );

    await ws.writeConfig({
      repoId: 'repo-alpha',
      allowedRoles: ['general', 'builder', 'reviewer'],
    });
    expect(missingHarness.getConfig().repoId).toBe('repo-alpha');
    expect(missingHarness.getConfig().allowedRoles).toEqual(['general', 'builder', 'reviewer']);

    await ws.writeWorkspaceFile(
      'custom/custom-memory.json',
      JSON.stringify({
        repoId: 'repo-custom',
        allowedRoles: ['general', 'verifier'],
      }),
    );
    const customHarness = new MemoryHarness({
      workspaceRoot: ws.workspaceRoot,
      configPath: 'custom/custom-memory.json',
    });
    expect(customHarness.getConfig().repoId).toBe('repo-custom');
  });

  it('verifies memory_init unscoped-only loading, scoped read-count note protection, lock order, sessionId env fallbacks, and PENDING_HOOK_EPOCH state', async () => {
    const ws = await createTempMemoryWorkspace({
      files: {
        'packages/foo/src/index.ts': 'export const x = 1;\n',
      },
    });
    activeWorkspaces.push(ws);

    let currentNowMs = Date.parse('2026-11-09T12:00:00.000Z');
    const harness = new MemoryHarness({
      workspaceRoot: ws.workspaceRoot,
      nowMs: () => currentNowMs,
    });

    await expect(harness.init({ role: 'unknown-role' })).rejects.toThrowError(
      expect.objectContaining({
        code: 'INVALID_ROLE',
        details: expect.objectContaining({
          allowedRoles: ['general', 'builder', 'reviewer', 'verifier', 'head'],
        }),
      }),
    );

    await expect(
      harness.init({ role: 'builder', sessionId: 'latest-role' }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
      }),
    );

    await expect(
      harness.init({ role: 'builder', sessionId: '../escape' }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
      }),
    );

    await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'rule',
      role: 'general',
      text: 'Never read .env files.',
    });
    await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_ONE,
    });
    await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'note',
      role: 'builder',
      text: 'Unscoped one-shot handoff note.',
      lifecycle: { mode: 'read-count', remainingReads: 1 },
    });
    await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'note',
      role: 'builder',
      text: 'Scoped read-count note that memory_init must never decrement.',
      context: ['packages/foo/**'],
      lifecycle: { mode: 'read-count', remainingReads: 2 },
    });

    const latestRolePath = path.join(ws.sessionStateDir, 'latest-role.json');
    const latestRoleLockPath = path.join(ws.sessionStateDir, 'latest-role.lock');
    const sessionPath = path.join(ws.sessionStateDir, 'sess-explicit.json');
    await mkdir(ws.sessionStateDir, { recursive: true });
    await writeFile(
      sessionPath,
      JSON.stringify({
        sessionId: 'sess-explicit',
        role: 'general',
        lastCompactionCheckpointId: 'epoch-0',
        seenRecordIds: ['L1'],
        lastScannedTranscriptOffset: 128,
        transcriptPath: 'transcript.jsonl',
        updatedAt: '2026-11-09T11:00:00.000Z',
      }),
      'utf8',
    );

    const initOut = await harness.init({
      role: 'builder',
      sessionId: 'sess-explicit',
    });

    expect(PathExistsSyncCheck(latestRoleLockPath)).toBe(false);
    expect(initOut.role).toBe('builder');
    expect(initOut.repoId).toBe('test-repo');
    expect(initOut.protocol).toContain('Three-Tier Filter Before Lesson Creation');
    expect(initOut.rules.map((r) => r.id)).toEqual(['R1']);
    expect(initOut.lessons.map((l) => l.id)).toEqual(['L1']);
    expect(initOut.notes.map((n) => ({
      id: n.id,
      drainedOnThisRead: n.drainedOnThisRead,
      renderedText: n.renderedText,
    }))).toEqual([
      {
        id: 'N1',
        drainedOnThisRead: true,
        renderedText: '[FINAL READ - DRAINED] Unscoped one-shot handoff note.',
      },
    ]);

    const latestRoleData = MemoryLatestRoleStateSchema.parse(
      JSON.parse(await readFile(latestRolePath, 'utf8')),
    );
    expect(latestRoleData).toEqual({
      role: 'builder',
      updatedAt: '2026-11-09T12:00:00.000Z',
    });

    const sessionData = MemorySessionEpochStateSchema.parse(
      JSON.parse(await readFile(sessionPath, 'utf8')),
    );
    expect(sessionData).toEqual({
      sessionId: 'sess-explicit',
      role: 'builder',
      lastCompactionCheckpointId: 'PENDING_HOOK_EPOCH',
      seenRecordIds: [],
      lastScannedTranscriptOffset: 128,
      transcriptPath: 'transcript.jsonl',
      updatedAt: '2026-11-09T12:00:00.000Z',
    });

    const scopedCheck = await harness.loadScoped({
      role: 'builder',
      paths: ['packages/foo/src/index.ts'],
      sessionId: 'sess-explicit',
    });
    expect(scopedCheck.notes.map((n) => ({
      id: n.id,
      remainingReads: n.lifecycle.mode === 'read-count' ? n.lifecycle.remainingReads : -1,
      drainedOnThisRead: n.drainedOnThisRead,
    }))).toEqual([
      {
        id: 'N2',
        remainingReads: 1,
        drainedOnThisRead: false,
      },
    ]);

    process.env['CLAUDE_SESSION_ID'] = 'sess-from-claude-env';
    process.env['AGY_SESSION_ID'] = 'sess-from-agy-env';
    currentNowMs += 1000;
    await harness.init({ role: 'reviewer' });
    const claudeEnvState = MemorySessionEpochStateSchema.parse(
      JSON.parse(await readFile(path.join(ws.sessionStateDir, 'sess-from-claude-env.json'), 'utf8')),
    );
    expect(claudeEnvState.role).toBe('reviewer');

    delete process.env['CLAUDE_SESSION_ID'];
    await harness.init({ role: 'verifier' });
    const agyEnvState = MemorySessionEpochStateSchema.parse(
      JSON.parse(await readFile(path.join(ws.sessionStateDir, 'sess-from-agy-env.json'), 'utf8')),
    );
    expect(agyEnvState.role).toBe('verifier');
  });

  it('verifies memory_load_scoped returns only scoped records, tracks seenRecordIds, and loadScoped/commit/drainNotes never trigger autoPullOnInit fetch', async () => {
    const bareRemoteDir = await mkdtemp(path.join(os.tmpdir(), 'paraharness-memory-bare-'));
    extraTempDirs.push(bareRemoteDir);
    await execGitCommand({
      cwd: bareRemoteDir,
      useDashC: false,
      args: ['init', '--bare', '-b', 'main', bareRemoteDir],
    });

    const wsA = await createTempMemoryWorkspace({
      config: {
        repoId: 'repo-sync',
        allowedRoles: ['general', 'builder'],
        storage: {
          ledgerPath: '.memory/memory.jsonl',
          git: {
            enabled: true,
            checkoutDir: '.memory',
            remoteUrl: bareRemoteDir,
            branch: 'main',
            autoCommit: true,
            autoPush: false,
            autoPullOnInit: true,
          },
        },
      },
      files: {
        'packages/lockfile/src/index.ts': 'export {};\n',
      },
    });
    const wsB = await createTempMemoryWorkspace({
      config: {
        repoId: 'repo-sync',
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
      },
      files: {
        'packages/lockfile/src/index.ts': 'export {};\n',
      },
    });
    activeWorkspaces.push(wsA, wsB);

    const harnessA = new MemoryHarness({ workspaceRoot: wsA.workspaceRoot });
    const harnessB = new MemoryHarness({ workspaceRoot: wsB.workspaceRoot });

    await harnessB.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'rule',
      role: 'general',
      text: 'Unscoped rule in remote.',
    });
    await harnessB.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_ONE,
      context: ['packages/lockfile/**'],
    });

    await harnessA.init({ role: 'builder', sessionId: 'sid-a' });

    await harnessB.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_TWO,
      context: ['packages/lockfile/**'],
    });

    const scopedBeforeInit = await harnessA.loadScoped({
      role: 'builder',
      paths: ['packages/lockfile/src/index.ts'],
      sessionId: 'sid-a',
    });
    expect(scopedBeforeInit.rules).toEqual([]);
    expect(scopedBeforeInit.lessons.map((l) => l.id)).toEqual(['L1']);

    await harnessA.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'note',
      role: 'builder',
      text: 'Local note in A.',
      context: ['packages/lockfile/**'],
      lifecycle: { mode: 'persistent' },
    });
    const drainPreview = await harnessA.drainNotes({
      callerRole: 'builder',
      modes: ['persistent'],
      dryRun: true,
    });
    expect(drainPreview.matchedNotes.map((n) => n.id)).toEqual(['N1']);

    const scopedStillBeforeInit = await harnessA.loadScoped({
      role: 'builder',
      paths: ['packages/lockfile/src/index.ts'],
      sessionId: 'sid-a',
    });
    expect(scopedStillBeforeInit.lessons.map((l) => l.id)).toEqual(['L1']);

    const sessionStateAfterScoped = MemorySessionEpochStateSchema.parse(
      JSON.parse(await readFile(path.join(wsA.sessionStateDir, 'sid-a.json'), 'utf8')),
    );
    expect(sessionStateAfterScoped.seenRecordIds).toEqual(['L1', 'N1']);

    await harnessA.init({ role: 'builder', sessionId: 'sid-a' });
    const scopedAfterInitPull = await harnessA.loadScoped({
      role: 'builder',
      paths: ['packages/lockfile/src/index.ts'],
      sessionId: 'sid-a',
    });
    expect(scopedAfterInitPull.lessons.map((l) => l.id)).toEqual(['L1', 'L2']);
  });

  it('verifies memory_propose in delegate_to_subagent and resolved modes, lock release before runner execution, RULE_PROTECTION_VIOLATION, and capMerge zone validation', async () => {
    const ws = await createTempMemoryWorkspace({
      config: {
        repoId: 'repo-propose',
        allowedRoles: ['general', 'builder', 'reviewer'],
        caps: [
          {
            roles: ['builder'],
            paths: [],
            types: ['lesson'],
            softCap: 2,
            hardCap: 3,
          },
        ],
      },
    });
    activeWorkspaces.push(ws);

    const delegateHarness = new MemoryHarness({ workspaceRoot: ws.workspaceRoot });
    const delegated = await delegateHarness.propose({
      callerRole: 'builder',
      targetRole: 'builder',
      type: 'lesson',
      rawText: VALID_LESSON_ONE,
    });
    expect(delegated.executionMode).toBe('delegate_to_subagent');
    expect(delegated.requiresOwnerGo).toBe(false);
    expect(delegated.bucketStatus.zone).toBe('UNDER_SOFT_CAP');
    if (delegated.executionMode === 'delegate_to_subagent') {
      expect(delegated.delegateToSubagent.model).toBe('opus');
      expect(delegated.delegateToSubagent.systemPrompt).toContain(
        'Unified Memory Distiller System Prompt',
      );
      expect(delegated.delegateToSubagent.userPrompt).toContain(VALID_LESSON_ONE);
    }

    let lockWasFreeDuringRunner = false;
    const fakeRunner = new FakeMemoryDistillerRunner({
      onProposal: async () => {
        await withFileLock(`${ws.ledgerPath}.lock`, async () => {
          lockWasFreeDuringRunner = true;
        });
        return {
          matchStatus: 'NO_MATCH',
          recommendedChoiceIndex: 0,
          choices: [
            {
              op: 'add',
              proposedText: VALID_LESSON_ONE,
              proposedRole: 'builder',
            },
          ],
        };
      },
    });

    const resolvedHarness = new MemoryHarness({
      workspaceRoot: ws.workspaceRoot,
      distillerRunner: fakeRunner,
    });

    const resolvedAdd = await resolvedHarness.propose({
      callerRole: 'builder',
      targetRole: 'builder',
      type: 'lesson',
      rawText: VALID_LESSON_ONE,
    });
    expect(lockWasFreeDuringRunner).toBe(true);
    expect(resolvedAdd.executionMode).toBe('resolved');
    if (resolvedAdd.executionMode === 'resolved') {
      expect(resolvedAdd.matchStatus).toBe('NO_MATCH');
      expect(resolvedAdd.choices).toEqual([
        {
          op: 'add',
          proposedText: VALID_LESSON_ONE,
          proposedRole: 'builder',
          proposedContext: undefined,
          proposedRepos: undefined,
          capMerge: undefined,
        },
      ]);
    }

    await resolvedHarness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'rule',
      role: 'general',
      text: 'Owner rule R1.',
    });
    await resolvedHarness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_ONE,
    });

    fakeRunner.setHandler(() => ({
      matchStatus: 'LIKELY_MATCH',
      recommendedChoiceIndex: 0,
      choices: [
        {
          op: 'update',
          targetId: 'L1',
          whyMatched: 'Same underlying p-queue AbortSignal mechanism.',
          proposedText: VALID_LESSON_TWO,
          proposedRole: 'builder',
        },
      ],
    }));
    const resolvedUpdate = await resolvedHarness.propose({
      callerRole: 'builder',
      targetRole: 'builder',
      type: 'lesson',
      rawText: VALID_LESSON_TWO,
    });
    if (resolvedUpdate.executionMode === 'resolved') {
      expect(resolvedUpdate.choices[0]?.op).toBe('update');
      if (resolvedUpdate.choices[0]?.op === 'update') {
        expect(resolvedUpdate.choices[0].existingRecord.id).toBe('L1');
      }
    }

    fakeRunner.setHandler(() => ({
      matchStatus: 'LIKELY_MATCH',
      recommendedChoiceIndex: 0,
      choices: [
        {
          op: 'update',
          targetId: 'R1',
          whyMatched: 'Illegal attempt to overwrite rule R1 from a lesson proposal.',
          proposedText: VALID_LESSON_TWO,
          proposedRole: 'builder',
        },
      ],
    }));
    await expect(
      resolvedHarness.propose({
        callerRole: 'builder',
        targetRole: 'builder',
        type: 'lesson',
        rawText: VALID_LESSON_TWO,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'RULE_PROTECTION_VIOLATION',
      }),
    );

    fakeRunner.setHandler(() => ({
      matchStatus: 'NO_MATCH',
      recommendedChoiceIndex: 0,
      choices: [
        {
          op: 'add',
          proposedText: VALID_LESSON_TWO,
          proposedRole: 'builder',
          capMerge: {
            keepId: 'L1',
            removeId: 'L2',
            mergedText: VALID_LESSON_MERGED,
            whyMerged: 'Invalid capMerge while still in UNDER_SOFT_CAP.',
          },
        },
      ],
    }));
    await expect(
      resolvedHarness.propose({
        callerRole: 'builder',
        targetRole: 'builder',
        type: 'lesson',
        rawText: VALID_LESSON_TWO,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'DISTILLER_EXECUTION_FAILED',
      }),
    );
  });

  it('verifies ClaudeCliDistillerRunner via temp-dir claude executable on PATH across all 3 stdout shapes, trailing userPrompt arg, timeout, non-zero exit, and invalid choice hydration', async () => {
    const binDir = await mkdtemp(path.join(os.tmpdir(), 'paraharness-fake-claude-bin-'));
    extraTempDirs.push(binDir);
    const argsCapturePath = path.join(binDir, 'captured-args.json');
    const modeFilePath = path.join(binDir, 'mode.txt');
    const claudeBinPath = path.join(binDir, 'claude');

    const fakeClaudeScript = [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      `const argsPath = ${JSON.stringify(argsCapturePath)};`,
      `const modePath = ${JSON.stringify(modeFilePath)};`,
      'fs.writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)), "utf8");',
      'const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, "utf8").trim() : "structured_output";',
      'const payload = {',
      '  matchStatus: "NO_MATCH",',
      '  recommendedChoiceIndex: 0,',
      '  choices: [{',
      '    op: "add",',
      `    proposedText: ${JSON.stringify(VALID_LESSON_ONE)},`,
      '    proposedRole: "builder"',
      '  }]',
      '};',
      'if (mode === "structured_output") {',
      '  process.stdout.write(JSON.stringify({ type: "result", structured_output: payload }));',
      '} else if (mode === "result_string") {',
      '  process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify(payload) }));',
      '} else if (mode === "bare_json") {',
      '  process.stdout.write(JSON.stringify(payload));',
      '} else if (mode === "invalid_choice_hydration") {',
      '  process.stdout.write(JSON.stringify({',
      '    matchStatus: "LIKELY_MATCH",',
      '    recommendedChoiceIndex: 0,',
      '    choices: [{',
      '      op: "update",',
      '      targetId: "L999",',
      '      whyMatched: "Non-existent targetId",',
      `      proposedText: ${JSON.stringify(VALID_LESSON_ONE)},`,
      '      proposedRole: "builder"',
      '    }]',
      '  }));',
      '} else if (mode === "nonzero_exit") {',
      '  process.stderr.write("fatal claude cli error\\n");',
      '  process.exit(2);',
      '} else if (mode === "timeout") {',
      '  process.stdin.resume();',
      '}',
    ].join('\n');

    await writeFile(claudeBinPath, fakeClaudeScript, 'utf8');
    await chmod(claudeBinPath, 0o755);

    const originalPath = process.env['PATH'] ?? '';
    process.env['PATH'] = `${binDir}${path.delimiter}${originalPath}`;

    try {
      const ws = await createTempMemoryWorkspace({
        config: {
          repoId: 'repo-cli',
          allowedRoles: ['general', 'builder'],
          distiller: {
            runner: 'claude-cli',
            model: 'opus',
            effort: 'high',
            timeoutMs: 1000,
          },
        },
      });
      activeWorkspaces.push(ws);

      const harness = new MemoryHarness({
        workspaceRoot: ws.workspaceRoot,
        distillerRunner: new ClaudeCliDistillerRunner(),
      });

      await writeFile(modeFilePath, 'structured_output', 'utf8');
      const outStructured = await harness.propose({
        callerRole: 'builder',
        targetRole: 'builder',
        type: 'lesson',
        rawText: VALID_LESSON_ONE,
      });
      expect(outStructured.executionMode).toBe('resolved');
      const capturedArgs = JSON.parse(await readFile(argsCapturePath, 'utf8')) as string[];
      expect(capturedArgs[0]).toBe('-p');
      expect(capturedArgs).toContain('--model');
      expect(capturedArgs).toContain('--effort');
      expect(capturedArgs).toContain('--system-prompt');
      expect(capturedArgs).toContain('--output-format');
      expect(capturedArgs).toContain('--json-schema');
      expect(capturedArgs[capturedArgs.length - 1]).toContain(
        '# Candidate Memory Proposal Request',
      );

      await writeFile(modeFilePath, 'result_string', 'utf8');
      const outResultString = await harness.propose({
        callerRole: 'builder',
        targetRole: 'builder',
        type: 'lesson',
        rawText: VALID_LESSON_ONE,
      });
      expect(outResultString.executionMode).toBe('resolved');

      await writeFile(modeFilePath, 'bare_json', 'utf8');
      const outBare = await harness.propose({
        callerRole: 'builder',
        targetRole: 'builder',
        type: 'lesson',
        rawText: VALID_LESSON_ONE,
      });
      expect(outBare.executionMode).toBe('resolved');

      await writeFile(modeFilePath, 'invalid_choice_hydration', 'utf8');
      await expect(
        harness.propose({
          callerRole: 'builder',
          targetRole: 'builder',
          type: 'lesson',
          rawText: VALID_LESSON_ONE,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'DISTILLER_EXECUTION_FAILED',
        }),
      );

      await writeFile(modeFilePath, 'nonzero_exit', 'utf8');
      await expect(
        harness.propose({
          callerRole: 'builder',
          targetRole: 'builder',
          type: 'lesson',
          rawText: VALID_LESSON_ONE,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'DISTILLER_EXECUTION_FAILED',
        }),
      );

      await writeFile(modeFilePath, 'timeout', 'utf8');
      await expect(
        harness.propose({
          callerRole: 'builder',
          targetRole: 'builder',
          type: 'lesson',
          rawText: VALID_LESSON_ONE,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'DISTILLER_EXECUTION_FAILED',
        }),
      );
    } finally {
      process.env['PATH'] = originalPath;
    }
  });

  it('verifies memory_commit (add, update widening & alsoRemoveIds, lifecycle rejection on non-note, bucket-transition CAP_EXCEEDED, remove reasons & monotonic ID non-reuse, capMerge union & zone rules)', async () => {
    const ws = await createTempMemoryWorkspace({
      config: {
        repoId: 'repo-commit',
        allowedRoles: ['general', 'builder', 'reviewer'],
        caps: [
          {
            roles: ['builder'],
            paths: [],
            types: ['lesson'],
            softCap: 2,
            hardCap: 2,
          },
          {
            roles: ['reviewer'],
            paths: [],
            types: ['lesson'],
            softCap: 1,
            hardCap: 1,
          },
          {
            roles: ['*'],
            paths: ['packages/a/**', 'packages/b/**'],
            types: ['lesson'],
            softCap: 2,
            hardCap: 3,
          },
        ],
      },
      files: {
        'packages/a/index.ts': 'export const a = 1;\n',
        'packages/b/index.ts': 'export const b = 2;\n',
      },
    });
    activeWorkspaces.push(ws);

    const harness = new MemoryHarness({ workspaceRoot: ws.workspaceRoot });

    await expect(
      harness.commit({
        op: 'add',
        callerRole: 'builder',
        type: 'lesson',
        role: 'builder',
        text: 'Invalid lesson without causal connector.',
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'LESSON_FORMAT_INVALID',
      }),
    );

    const addL1 = await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_ONE,
      context: ['packages/a/**'],
      repos: ['repo-commit'],
    });
    expect(addL1.committedRecord?.id).toBe('L1');

    await expect(
      harness.commit({
        op: 'add',
        callerRole: 'builder',
        type: 'lesson',
        role: 'builder',
        text: VALID_LESSON_TWO,
        context: ['packages/a/**'],
        capMerge: {
          keepId: 'L1',
          removeId: 'L2',
          mergedText: VALID_LESSON_MERGED,
        },
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
      }),
    );

    await expect(
      harness.commit({
        op: 'update',
        callerRole: 'builder',
        id: 'L1',
        text: VALID_LESSON_ONE,
        lifecycle: { mode: 'persistent' },
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
      }),
    );

    await harness.commit({
      op: 'add',
      callerRole: 'reviewer',
      type: 'lesson',
      role: 'reviewer',
      text: VALID_LESSON_ONE,
    });

    await expect(
      harness.commit({
        op: 'update',
        callerRole: 'builder',
        id: 'L1',
        text: VALID_LESSON_ONE,
        role: 'reviewer',
        context: null,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'CAP_EXCEEDED',
      }),
    );

    const addL3Scoped = await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_TWO,
      context: ['packages/b/**'],
      repos: ['repo-commit', 'repo-other'],
    });
    expect(addL3Scoped.committedRecord?.id).toBe('L3');

    const widenedL1 = await harness.commit({
      op: 'update',
      callerRole: 'builder',
      id: 'L1',
      text: VALID_LESSON_MERGED,
      context: null,
      repos: null,
      alsoRemoveIds: ['L3'],
    });
    expect(widenedL1.committedRecord?.context).toBeUndefined();
    expect(widenedL1.committedRecord?.repos).toBeUndefined();
    expect(widenedL1.removedIds).toEqual(['L3']);

    const addL4Unscoped = await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_ONE,
    });
    expect(addL4Unscoped.committedRecord?.id).toBe('L4');
    expect(addL4Unscoped.bucketStatusAfter?.zone).toBe('AT_HARD_CAP');

    await expect(
      harness.commit({
        op: 'add',
        callerRole: 'builder',
        type: 'lesson',
        role: 'builder',
        text: VALID_LESSON_TWO,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'CAP_EXCEEDED',
      }),
    );

    const capMergedAdd = await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_TWO,
      capMerge: {
        keepId: 'L1',
        removeId: 'L4',
        mergedText: VALID_LESSON_MERGED,
      },
    });
    expect(capMergedAdd.committedRecord?.id).toBe('L5');
    expect(capMergedAdd.mergedKeepRecord?.id).toBe('L1');
    expect(capMergedAdd.mergedKeepRecord?.text).toBe(VALID_LESSON_MERGED);
    expect(capMergedAdd.removedIds).toEqual(['L4']);
    expect(capMergedAdd.bucketStatusAfter?.currentCount).toBe(2);

    const addR1 = await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'rule',
      role: 'general',
      text: 'Owner rule R1.',
    });
    expect(addR1.committedRecord?.id).toBe('R1');

    await expect(
      harness.commit({
        op: 'remove',
        callerRole: 'builder',
        id: 'R1',
        reason: 'promoted_to_tier1_or_tier2',
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'RULE_PROTECTION_VIOLATION',
      }),
    );

    await expect(
      harness.commit({
        op: 'add',
        callerRole: 'builder',
        type: 'lesson',
        role: 'builder',
        text: VALID_LESSON_ONE,
        capMerge: {
          keepId: 'R1',
          removeId: 'L1',
          mergedText: VALID_LESSON_MERGED,
        },
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'RULE_PROTECTION_VIOLATION',
      }),
    );

    const removedR1 = await harness.commit({
      op: 'remove',
      callerRole: 'builder',
      id: 'R1',
      reason: 'owner_veto',
    });
    expect(removedR1.removedIds).toEqual(['R1']);

    const addR2 = await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'rule',
      role: 'general',
      text: 'Second Owner rule must receive R2, never reusing R1.',
    });
    expect(addR2.committedRecord?.id).toBe('R2');

    const removedL2 = await harness.commit({
      op: 'remove',
      callerRole: 'reviewer',
      id: 'L2',
      reason: 'promoted_to_tier1_or_tier2',
    });
    expect(removedL2.removedIds).toEqual(['L2']);

    const removedL5 = await harness.commit({
      op: 'remove',
      callerRole: 'builder',
      id: 'L5',
      reason: 'merged_into_wider_record',
    });
    expect(removedL5.removedIds).toEqual(['L5']);

    const addN1 = await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'note',
      role: 'builder',
      text: 'Temporary note N1.',
      lifecycle: { mode: 'persistent' },
    });
    expect(addN1.committedRecord?.id).toBe('N1');

    await expect(
      harness.commit({
        op: 'remove',
        callerRole: 'builder',
        id: 'N1',
        reason: 'promoted_to_tier1_or_tier2',
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
      }),
    );

    const removedN1 = await harness.commit({
      op: 'remove',
      callerRole: 'builder',
      id: 'N1',
      reason: 'note_settled_or_obsolete',
    });
    expect(removedN1.removedIds).toEqual(['N1']);

    await expect(
      harness.commit({
        op: 'remove',
        callerRole: 'builder',
        id: 'N999',
        reason: 'note_settled_or_obsolete',
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'RECORD_NOT_FOUND',
      }),
    );

    const addL6 = await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_ONE,
      context: ['packages/a/**'],
      repos: ['repo-commit'],
    });
    expect(addL6.committedRecord?.id).toBe('L6');
    const addL7 = await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_TWO,
      context: ['packages/b/**'],
      repos: ['repo-commit', 'repo-other'],
    });
    expect(addL7.committedRecord?.id).toBe('L7');
    const scopedCapMerge = await harness.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_ONE,
      context: ['packages/a/**'],
      capMerge: {
        keepId: 'L6',
        removeId: 'L7',
        mergedText: VALID_LESSON_MERGED,
      },
    });
    expect(scopedCapMerge.mergedKeepRecord?.context).toEqual(['packages/a/**', 'packages/b/**']);
    expect(scopedCapMerge.mergedKeepRecord?.repos).toEqual(['repo-commit', 'repo-other']);
  });

  it('verifies memory_commit Git cumulativeIdRemap output remapping and memory_drain_notes dryRun vs destructive filtering', async () => {
    const bareRemoteDir = await mkdtemp(path.join(os.tmpdir(), 'paraharness-commit-remap-bare-'));
    extraTempDirs.push(bareRemoteDir);
    await execGitCommand({
      cwd: bareRemoteDir,
      useDashC: false,
      args: ['init', '--bare', '-b', 'main', bareRemoteDir],
    });

    const gitConfig = {
      repoId: 'repo-remap',
      allowedRoles: ['general', 'builder', 'reviewer'],
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

    const ws1 = await createTempMemoryWorkspace({
      config: gitConfig,
      files: {
        'packages/core/src/index.ts': 'export {};\n',
      },
    });
    const ws2 = await createTempMemoryWorkspace({
      config: gitConfig,
      files: {
        'packages/core/src/index.ts': 'export {};\n',
      },
    });
    activeWorkspaces.push(ws1, ws2);

    const harness1 = new MemoryHarness({ workspaceRoot: ws1.workspaceRoot });
    const harness2 = new MemoryHarness({ workspaceRoot: ws2.workspaceRoot });

    await harness1.init({ role: 'builder', sessionId: 's1' });
    await harness2.init({ role: 'builder', sessionId: 's2' });

    const remoteCommit = await harness1.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_ONE,
    });
    expect(remoteCommit.committedRecord?.id).toBe('L1');
    expect(remoteCommit.gitPushed).toBe(true);

    const divergedCommit = await harness2.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'lesson',
      role: 'builder',
      text: VALID_LESSON_TWO,
    });
    expect(divergedCommit.committedRecord?.id).toBe('L2');
    expect(divergedCommit.gitCommitted).toBe(true);
    expect(divergedCommit.gitPushed).toBe(true);
    expect(divergedCommit.bucketStatusAfter?.bucketRecordIds).toEqual(['L1', 'L2']);

    await harness2.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'note',
      role: 'builder',
      text: 'Persistent core note.',
      context: ['packages/core/**'],
      lifecycle: { mode: 'persistent' },
    });
    await harness2.commit({
      op: 'add',
      callerRole: 'builder',
      type: 'note',
      role: 'reviewer',
      text: 'Read-count reviewer note.',
      lifecycle: { mode: 'read-count', remainingReads: 3 },
    });

    const preview = await harness2.drainNotes({
      callerRole: 'builder',
      modes: ['persistent', 'read-count'],
      role: 'builder',
      paths: ['packages/core/src/index.ts'],
      ids: ['N1'],
      dryRun: true,
    });
    expect(preview.dryRun).toBe(true);
    expect(preview.matchedNotes.map((n) => n.id)).toEqual(['N1']);
    expect(preview.drainedIds).toEqual([]);

    const drained = await harness2.drainNotes({
      callerRole: 'builder',
      modes: ['*'],
      role: 'builder',
      paths: ['packages/core/src/index.ts'],
      ids: ['N1'],
      dryRun: false,
    });
    expect(drained.dryRun).toBe(false);
    expect(drained.drainedIds).toEqual(['N1']);
    expect(drained.gitCommitted).toBe(true);

    const remainingCheck = await harness2.drainNotes({
      callerRole: 'builder',
      modes: ['*'],
      dryRun: true,
    });
    expect(remainingCheck.matchedNotes.map((n) => n.id)).toEqual(['N2']);
  });
});

function PathExistsSyncCheck(targetPath: string): boolean {
  try {
    return process.getBuiltinModule('node:fs').existsSync(targetPath);
  } catch {
    return false;
  }
}
