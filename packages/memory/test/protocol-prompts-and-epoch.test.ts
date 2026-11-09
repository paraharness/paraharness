import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@paraharness/lockfile';
import { describe, expect, it } from 'vitest';
import {
  extractTouchedPathsFromHookInput,
  MemoryConfigSchema,
  type MemoryRecord,
} from '../src/index.js';
import { buildDistillerPrompts } from '../src/internal/build-distiller-prompts.js';
import { buildMemoryProtocol } from '../src/internal/build-memory-protocol.js';
import { resolveRecordCapBucket } from '../src/internal/resolve-record-cap-bucket.js';
import {
  persistSessionEpochState,
  resolveSessionEpochState,
} from '../src/internal/resolve-session-epoch-state.js';
import { createTempMemoryWorkspace } from './fixtures/create-temp-memory-workspace.js';

describe('Memory protocol generation, KV-cached Distiller prompts, hook path extraction & session compaction epoch state', () => {
  it('generates config-adapted markdown instructions in buildMemoryProtocol', () => {
    const config = MemoryConfigSchema.parse({
      repoId: 'proto-repo',
      allowedRoles: ['general', 'builder', 'reviewer'],
      format: {
        maxChars: 420,
        template: 'Do <Action> when <Trigger>, because <Mechanism>.',
        requireSubstrings: [' because ', ' when '],
        requireSingleSentence: true,
        forbidRegexes: ['\\bTODO\\b'],
      },
      distiller: {
        runner: 'claude-cli',
        model: 'sonnet',
      },
    });
    const protocol = buildMemoryProtocol(config, 'builder');
    expect(protocol).toContain('proto-repo');
    expect(protocol).toContain('role: `builder`');
    expect(protocol).toContain('Do <Action> when <Trigger>, because <Mechanism>.');
    expect(protocol).toContain('420');
    expect(protocol).toContain('" because ", " when "');
    expect(protocol).toContain('/\\bTODO\\b/u');
    expect(protocol).toContain('executionMode === "resolved"');
    expect(protocol).toContain('executionMode === "delegate_to_subagent"');
    expect(protocol).toContain('memory_drain_notes');
    expect(protocol).toContain('memory_load_scoped');
  });

  it('builds byte-identical KV-cached systemPrompt with CLAUDE.MD/CLAUDE.md fallback, POSIX code-unit sorted docs/rules/*.md, customInstructions, and canonical R*/L* records, plus bucketRecordIds in userPrompt', async () => {
    const wsUpper = await createTempMemoryWorkspace({
      files: {
        'CLAUDE.MD': '# Root CLAUDE.MD Content',
        'docs/rules/Z_RULE.md': '# Z Rule Content',
        'docs/rules/A_RULE.md': '# A Rule Content',
        'docs/rules/B_RULE.md': '# B Rule Content',
      },
    });
    const wsLower = await createTempMemoryWorkspace({
      files: {
        'CLAUDE.md': '# Fallback Lowercase CLAUDE.md Content',
      },
    });
    try {
      const config = MemoryConfigSchema.parse({
        repoId: 'prompt-repo',
        allowedRoles: ['general', 'builder'],
        distiller: {
          runner: 'subagent',
          model: 'opus',
          effort: 'high',
          timeoutMs: 120000,
          customInstructions: 'Enforce strict Paraharness AST purity.',
        },
      });
      const records: MemoryRecord[] = [
        {
          id: 'L2',
          type: 'lesson',
          role: 'builder',
          text: 'Lesson two text',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
        {
          id: 'N1',
          type: 'note',
          role: 'general',
          text: 'Notes are excluded from Distiller systemPrompt',
          createdAt: '2026-11-09T10:00:00.000Z',
          lifecycle: { mode: 'persistent' },
        },
        {
          id: 'R1',
          type: 'rule',
          role: 'general',
          text: 'Rule one text',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
        {
          id: 'L1',
          type: 'lesson',
          role: 'general',
          text: 'Lesson one text',
          createdAt: '2026-11-09T10:00:00.000Z',
        },
      ];

      const bucketA = resolveRecordCapBucket({
        candidate: { type: 'lesson', role: 'builder' },
        records,
        config,
      });
      const bucketB = resolveRecordCapBucket({
        candidate: { type: 'rule', role: 'general' },
        records,
        config,
      });

      const promptsA = buildDistillerPrompts({
        workspaceRoot: wsUpper.workspaceRoot,
        config,
        records,
        candidate: {
          callerRole: 'builder',
          targetRole: 'builder',
          type: 'lesson',
          rawText: 'Candidate lesson A',
          incident: 'Incident A',
        },
        bucketStatus: bucketA,
      });
      const promptsB = buildDistillerPrompts({
        workspaceRoot: wsUpper.workspaceRoot,
        config,
        records,
        candidate: {
          callerRole: 'builder',
          targetRole: 'general',
          type: 'rule',
          rawText: 'Candidate rule B',
          context: ['packages/memory/**'],
        },
        normalizedContext: ['packages/memory/**'],
        bucketStatus: bucketB,
      });

      expect(promptsA.systemPrompt).toBe(promptsB.systemPrompt);
      expect(promptsA.systemPrompt).toContain('### File: CLAUDE.MD\n# Root CLAUDE.MD Content');
      expect(promptsA.systemPrompt).toContain('Enforce strict Paraharness AST purity.');
      expect(promptsA.systemPrompt).not.toContain('Notes are excluded from Distiller systemPrompt');

      const idxA = promptsA.systemPrompt.indexOf('### File: docs/rules/A_RULE.md');
      const idxB = promptsA.systemPrompt.indexOf('### File: docs/rules/B_RULE.md');
      const idxZ = promptsA.systemPrompt.indexOf('### File: docs/rules/Z_RULE.md');
      expect(idxA).toBeGreaterThan(0);
      expect(idxB).toBeGreaterThan(idxA);
      expect(idxZ).toBeGreaterThan(idxB);

      const idxR1 = promptsA.systemPrompt.indexOf('"id":"R1"');
      const idxL1 = promptsA.systemPrompt.indexOf('"id":"L1"');
      const idxL2 = promptsA.systemPrompt.indexOf('"id":"L2"');
      expect(idxR1).toBeGreaterThan(0);
      expect(idxL1).toBeGreaterThan(idxR1);
      expect(idxL2).toBeGreaterThan(idxL1);

      expect(promptsA.userPrompt).toContain('"bucketRecordIds"');
      expect(promptsA.userPrompt).toContain('"L2"');

      const promptsFallback = buildDistillerPrompts({
        workspaceRoot: wsLower.workspaceRoot,
        config,
        records,
        candidate: {
          callerRole: 'builder',
          targetRole: 'builder',
          type: 'lesson',
          rawText: 'Candidate lesson fallback',
        },
        bucketStatus: bucketA,
      });
      expect(promptsFallback.systemPrompt).toContain(
        '### File: CLAUDE.md\n# Fallback Lowercase CLAUDE.md Content',
      );
    } finally {
      await wsUpper.cleanup();
      await wsLower.cleanup();
    }
  });

  it('extracts and normalizes touched paths across all Claude Code and Antigravity tool payload shapes while excluding search regex/query strings', () => {
    const root = '/workspace';

    expect(
      extractTouchedPathsFromHookInput(
        {
          tool_name: 'Read',
          tool_input: { file_path: '/workspace/packages/memory/src/index.ts' },
        },
        root,
      ),
    ).toEqual(['packages/memory/src/index.ts']);

    expect(
      extractTouchedPathsFromHookInput(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: 'packages/memory/src/a.ts',
            path: 'packages/memory/src/b.ts',
            paths: ['packages/memory/src/c.ts'],
          },
        },
        root,
      ),
    ).toEqual([
      'packages/memory/src/a.ts',
      'packages/memory/src/b.ts',
      'packages/memory/src/c.ts',
    ]);

    expect(
      extractTouchedPathsFromHookInput(
        {
          tool_name: 'MultiEdit',
          tool_input: { file_path: './packages/memory/src/multi.ts' },
        },
        root,
      ),
    ).toEqual(['packages/memory/src/multi.ts']);

    expect(
      extractTouchedPathsFromHookInput(
        {
          tool_name: 'Write',
          tool_input: { file_path: '/workspace/packages/memory/README.md' },
        },
        root,
      ),
    ).toEqual(['packages/memory/README.md']);

    expect(
      extractTouchedPathsFromHookInput(
        {
          tool_name: 'NotebookEdit',
          tool_input: {
            notebook_path: 'notebooks/analysis.ipynb',
            file_path: 'notebooks/backup.ipynb',
          },
        },
        root,
      ),
    ).toEqual(['notebooks/analysis.ipynb', 'notebooks/backup.ipynb']);

    expect(
      extractTouchedPathsFromHookInput(
        {
          tool_name: 'Glob',
          tool_input: {
            path: '/workspace/packages/memory/',
            pattern: '/src/**/*.ts',
          },
        },
        root,
      ),
    ).toEqual(['packages/memory/src/**/*.ts']);

    expect(
      extractTouchedPathsFromHookInput(
        {
          tool_name: 'Glob',
          tool_input: {
            pattern: 'packages/lockfile/*.ts',
          },
        },
        root,
      ),
    ).toEqual(['packages/lockfile/*.ts']);

    expect(
      extractTouchedPathsFromHookInput(
        {
          tool_name: 'Grep',
          tool_input: {
            path: 'packages/memory/',
            glob: '/src/*.ts',
            pattern: 'should_never_be_extracted_as_path',
          },
        },
        root,
      ),
    ).toEqual(['packages/memory/src/*.ts']);

    expect(
      extractTouchedPathsFromHookInput(
        {
          tool_name: 'Grep',
          tool_input: {
            pattern: 'only_regex_no_path_or_glob',
          },
        },
        root,
      ),
    ).toEqual(['**/*']);

    const antigravityCases: ReadonlyArray<{
      readonly payload: unknown;
      readonly expected: readonly string[];
    }> = [
      {
        payload: { tool_name: 'read_file', tool_input: { path: 'packages/a/read.ts' } },
        expected: ['packages/a/read.ts'],
      },
      {
        payload: {
          tool_name: 'view_file',
          tool_input: { AbsolutePath: '/workspace/packages/a/view.ts' },
        },
        expected: ['packages/a/view.ts'],
      },
      {
        payload: {
          tool_name: 'view_file_outline',
          tool_input: { AbsolutePath: '/workspace/packages/a/outline.ts' },
        },
        expected: ['packages/a/outline.ts'],
      },
      {
        payload: {
          tool_name: 'view_code_item',
          tool_input: { File: '/workspace/packages/a/item.ts' },
        },
        expected: ['packages/a/item.ts'],
      },
      {
        payload: {
          tool_name: 'edit_file',
          tool_input: { Path: '/workspace/packages/a/edit.ts', file_path: 'packages/a/edit2.ts' },
        },
        expected: ['packages/a/edit2.ts'],
      },
      {
        payload: {
          tool_name: 'write_file',
          tool_input: { file_path: '/workspace/packages/a/write.ts' },
        },
        expected: ['packages/a/write.ts'],
      },
      {
        payload: {
          tool_name: 'write_to_file',
          tool_input: { TargetFile: '/workspace/packages/a/write-to.ts' },
        },
        expected: ['packages/a/write-to.ts'],
      },
      {
        payload: {
          tool_name: 'replace_file_content',
          tool_input: { TargetFile: '/workspace/packages/a/replace.ts' },
        },
        expected: ['packages/a/replace.ts'],
      },
      {
        payload: {
          tool_name: 'multi_replace_file_content',
          tool_input: {
            TargetFile: '/workspace/packages/a/multi-replace.ts',
            Paths: ['packages/a/extra.ts'],
          },
        },
        expected: ['packages/a/multi-replace.ts', 'packages/a/extra.ts'],
      },
      {
        payload: {
          tool_name: 'find_by_name',
          tool_input: {
            SearchDirectory: '/workspace/packages/memory/',
            Pattern: '/*.schema.ts',
          },
        },
        expected: ['packages/memory/*.schema.ts'],
      },
      {
        payload: {
          tool_name: 'find_by_name',
          tool_input: {
            DirectoryPath: '/workspace/packages/lockfile/',
          },
        },
        expected: ['packages/lockfile'],
      },
      {
        payload: {
          tool_name: 'grep_search',
          tool_input: {
            SearchPath: '/workspace/packages/memory/',
            Includes: ['src/*.ts', '/test/*.test.ts'],
            Query: 'must_not_extract_query',
          },
        },
        expected: ['packages/memory/src/*.ts', 'packages/memory/test/*.test.ts'],
      },
      {
        payload: {
          tool_name: 'grep_search',
          tool_input: {
            Query: 'only_query_defaults_to_dot',
          },
        },
        expected: ['**/*'],
      },
    ];

    for (const testCase of antigravityCases) {
      expect(extractTouchedPathsFromHookInput(testCase.payload, root)).toEqual(testCase.expected);
    }
  });

  it('resolves session epoch state under <sessionId>.lock across full/incremental transcript scans, boundary ID fallback chain, truncation/path-change triggers, PENDING_HOOK_EPOCH, and role fallback precedence', async () => {
    const ws = await createTempMemoryWorkspace();
    try {
      const config = MemoryConfigSchema.parse({
        repoId: 'epoch-repo',
        allowedRoles: ['general', 'builder', 'reviewer', 'verifier'],
      });
      await mkdir(ws.sessionStateDir, { recursive: true });
      const lockPath = path.join(ws.sessionStateDir, 'sess-1.lock');

      await writeFile(
        path.join(ws.sessionStateDir, 'latest-role.json'),
        JSON.stringify({
          role: 'reviewer',
          updatedAt: '2026-11-09T10:00:00.000Z',
        }),
        'utf8',
      );

      await withFileLock(lockPath, async () => {
        const fromLatestRole = await resolveSessionEpochState({
          workspaceRoot: ws.workspaceRoot,
          config,
          sessionId: 'sess-1',
          nowMs: Date.parse('2026-11-09T10:01:00.000Z'),
        });
        expect(fromLatestRole.resolvedRole).toBe('reviewer');
        expect(fromLatestRole.compactionEpochId).toBe('epoch-0');
        expect(fromLatestRole.epochReset).toBe(true);
      });

      const transcriptOneRel = 'transcript-1.jsonl';
      const transcriptOneAbs = path.join(ws.workspaceRoot, transcriptOneRel);
      const initialLines = [
        JSON.stringify({
          type: 'tool_use',
          name: 'memory_init',
          input: { role: 'builder' },
        }),
        JSON.stringify({
          type: 'tool_use',
          name: 'view_file',
          input: { AbsolutePath: path.join(ws.workspaceRoot, 'packages/memory/src/index.ts') },
        }),
      ];
      await writeFile(transcriptOneAbs, `${initialLines.join('\n')}\n`, 'utf8');

      await persistSessionEpochState(ws.workspaceRoot, {
        sessionId: 'sess-1',
        role: 'builder',
        lastCompactionCheckpointId: 'PENDING_HOOK_EPOCH',
        seenRecordIds: ['L1', 'L2'],
        lastScannedTranscriptOffset: 0,
        transcriptPath: transcriptOneRel,
        updatedAt: '2026-11-09T10:02:00.000Z',
      });

      let offsetAfterStep1 = 0;
      await withFileLock(lockPath, async () => {
        const pendingBound = await resolveSessionEpochState({
          workspaceRoot: ws.workspaceRoot,
          config,
          sessionId: 'sess-1',
          transcriptPath: transcriptOneRel,
          nowMs: Date.parse('2026-11-09T10:03:00.000Z'),
        });
        expect(pendingBound.boundPendingHookEpoch).toBe(true);
        expect(pendingBound.epochReset).toBe(false);
        expect(pendingBound.compactionEpochId).toBe('epoch-0');
        expect(pendingBound.state.seenRecordIds).toEqual(['L1', 'L2']);
        expect(pendingBound.resolvedRole).toBe('builder');
        expect(pendingBound.transcriptTouchedPaths).toEqual(['packages/memory/src/index.ts']);
        offsetAfterStep1 = pendingBound.state.lastScannedTranscriptOffset;
        expect(offsetAfterStep1).toBeGreaterThan(0);
      });

      const incrementalLines = [
        ...initialLines,
        JSON.stringify({ type: 'CHECKPOINT', step_index: 42 }),
        JSON.stringify({
          type: 'tool_use',
          name: 'edit_file',
          input: { file_path: 'packages/memory/src/after-checkpoint.ts' },
        }),
      ];
      await writeFile(transcriptOneAbs, `${incrementalLines.join('\n')}\n`, 'utf8');

      await withFileLock(lockPath, async () => {
        const afterCheckpoint = await resolveSessionEpochState({
          workspaceRoot: ws.workspaceRoot,
          config,
          sessionId: 'sess-1',
          transcriptPath: transcriptOneRel,
          nowMs: Date.parse('2026-11-09T10:04:00.000Z'),
        });
        expect(afterCheckpoint.compactionEpochId).toBe('42');
        expect(afterCheckpoint.epochReset).toBe(true);
        expect(afterCheckpoint.state.seenRecordIds).toEqual([]);
        expect(afterCheckpoint.transcriptTouchedPaths).toEqual([
          'packages/memory/src/after-checkpoint.ts',
        ]);
        expect(afterCheckpoint.state.lastScannedTranscriptOffset).toBeGreaterThan(
          offsetAfterStep1,
        );
      });

      const boundaryChainLines = [
        ...incrementalLines,
        JSON.stringify({ type: 'compact_boundary', uuid: 'uuid-boundary-2' }),
        JSON.stringify({ subtype: 'compact_boundary', timestamp: '2026-11-09T10:05:00Z' }),
        JSON.stringify({ type: 'CHECKPOINT', created_at: '2026-11-09T10:06:00Z' }),
        JSON.stringify({ type: 'compact_boundary' }),
      ];
      const fullChainContent = `${boundaryChainLines.join('\n')}\n`;
      const lastLineOffset = Buffer.byteLength(
        `${boundaryChainLines.slice(0, -1).join('\n')}\n`,
        'utf8',
      );
      await writeFile(transcriptOneAbs, fullChainContent, 'utf8');

      await withFileLock(lockPath, async () => {
        const chainScan = await resolveSessionEpochState({
          workspaceRoot: ws.workspaceRoot,
          config,
          sessionId: 'sess-1',
          transcriptPath: transcriptOneRel,
          nowMs: Date.parse('2026-11-09T10:07:00.000Z'),
        });
        expect(chainScan.compactionEpochId).toBe(`offset:${lastLineOffset}`);
      });

      const truncatedLines = [
        JSON.stringify({ type: 'CHECKPOINT', uuid: 'after-truncation-uuid' }),
      ];
      await writeFile(transcriptOneAbs, `${truncatedLines.join('\n')}\n`, 'utf8');

      await withFileLock(lockPath, async () => {
        const rescanOnTruncate = await resolveSessionEpochState({
          workspaceRoot: ws.workspaceRoot,
          config,
          sessionId: 'sess-1',
          transcriptPath: transcriptOneRel,
          nowMs: Date.parse('2026-11-09T10:08:00.000Z'),
        });
        expect(rescanOnTruncate.compactionEpochId).toBe('after-truncation-uuid');
        expect(rescanOnTruncate.epochReset).toBe(true);
      });

      const transcriptTwoRel = 'transcript-2.jsonl';
      await writeFile(
        path.join(ws.workspaceRoot, transcriptTwoRel),
        `${JSON.stringify({
          type: 'CHECKPOINT',
          created_at: 'epoch-from-transcript-2',
        })}\n${JSON.stringify({
          type: 'tool_use',
          name: 'memory_init',
          input: { role: 'verifier' },
        })}\n`,
        'utf8',
      );

      await withFileLock(lockPath, async () => {
        const rescanOnPathChange = await resolveSessionEpochState({
          workspaceRoot: ws.workspaceRoot,
          config,
          sessionId: 'sess-1',
          transcriptPath: transcriptTwoRel,
          nowMs: Date.parse('2026-11-09T10:09:00.000Z'),
        });
        expect(rescanOnPathChange.compactionEpochId).toBe('epoch-from-transcript-2');
        expect(rescanOnPathChange.resolvedRole).toBe('verifier');
        expect(rescanOnPathChange.epochReset).toBe(true);
      });
    } finally {
      await ws.cleanup();
    }
  });
});
