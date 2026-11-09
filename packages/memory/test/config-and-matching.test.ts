import { describe, expect, it } from 'vitest';
import {
  DistillerStructuredOutputSchema,
  MemoryCommitInputSchema,
  MemoryConfigSchema,
  MemoryHarnessError,
  MemoryProposeOutputSchema,
  SessionIdSchema,
  type DistillerProposalRequest,
  type MemoryDistillerRunner,
  type MemoryHarnessContract,
  type MemoryHarnessOptions,
} from '../src/index.js';
import { buildRelativeProbes } from '../src/internal/build-relative-probes.js';
import { execGitCommand } from '../src/internal/exec-git-command.js';
import { extractStaticDirPrefix } from '../src/internal/extract-static-dir-prefix.js';
import { isDirectoryCandidate } from '../src/internal/is-directory-candidate.js';
import { isGlobPattern } from '../src/internal/is-glob-pattern.js';
import { listRepoFiles } from '../src/internal/list-repo-files.js';
import { loadMemoryConfig } from '../src/internal/load-memory-config.js';
import {
  matchesContextScope,
  matchSingleContextPair,
} from '../src/internal/matches-context-scope.js';
import {
  normalizeMemoryPathArray,
  normalizeMemoryPathPattern,
} from '../src/internal/normalize-memory-path-pattern.js';
import { validateLessonTextFormat } from '../src/internal/validate-lesson-text-format.js';
import { createTempMemoryWorkspace } from './fixtures/create-temp-memory-workspace.js';

describe('Config discovery, schema validation, path normalization & 4-way context matching', () => {
  it('discovers .agents/memory.config.json first, falls back to .claude/memory.config.json, supports explicit configPath, and throws CONFIG_NOT_FOUND when missing', async () => {
    const ws = await createTempMemoryWorkspace({ config: null });
    try {
      expect(() => loadMemoryConfig(ws.workspaceRoot)).toThrowError(MemoryHarnessError);
      try {
        loadMemoryConfig(ws.workspaceRoot);
      } catch (err) {
        expect(err).toBeInstanceOf(MemoryHarnessError);
        const memErr = err as MemoryHarnessError;
        expect(memErr.code).toBe('CONFIG_NOT_FOUND');
        expect(memErr.details).toEqual({
          probedPaths: [ws.agentsConfigPath, ws.claudeConfigPath],
        });
      }

      await ws.writeConfig(
        {
          repoId: 'claude-fallback-repo',
          allowedRoles: ['general', 'builder'],
        },
        'claude',
      );
      const fromClaude = loadMemoryConfig(ws.workspaceRoot);
      expect(fromClaude.config.repoId).toBe('claude-fallback-repo');
      expect(fromClaude.configPath).toBe(ws.claudeConfigPath);
      expect(fromClaude.compiledForbidRegexes.length).toBe(4);

      await ws.writeConfig(
        {
          repoId: 'agents-primary-repo',
          allowedRoles: ['general', 'builder', 'reviewer'],
        },
        'agents',
      );
      const fromAgents = loadMemoryConfig(ws.workspaceRoot);
      expect(fromAgents.config.repoId).toBe('agents-primary-repo');
      expect(fromAgents.configPath).toBe(ws.agentsConfigPath);

      await ws.writeWorkspaceFile(
        'custom/override.config.json',
        JSON.stringify({
          repoId: 'explicit-override-repo',
          allowedRoles: ['general'],
        }),
      );
      const fromOverride = loadMemoryConfig(ws.workspaceRoot, 'custom/override.config.json');
      expect(fromOverride.config.repoId).toBe('explicit-override-repo');

      expect(() => loadMemoryConfig(ws.workspaceRoot, 'custom/missing.json')).toThrowError(
        expect.objectContaining({
          code: 'CONFIG_NOT_FOUND',
        }),
      );
    } finally {
      await ws.cleanup();
    }
  });

  it('populates MemoryConfigSchema defaults (3 default cap rules with types=["lesson"]) and rejects invalid configurations with CONFIG_VALIDATION_FAILED', async () => {
    const ws = await createTempMemoryWorkspace({
      config: {
        repoId: 'defaults-repo',
        allowedRoles: ['general', 'builder'],
      },
    });
    try {
      const loaded = loadMemoryConfig(ws.workspaceRoot);
      expect(loaded.config.storage.ledgerPath).toBe('.memory/memory.jsonl');
      expect(loaded.config.storage.git).toEqual({
        enabled: false,
        checkoutDir: '.memory',
        branch: 'main',
        autoCommit: true,
        autoPush: false,
        autoPullOnInit: true,
      });
      expect(loaded.config.caps).toEqual([
        {
          roles: ['general'],
          paths: [],
          types: ['lesson'],
          softCap: 15,
          hardCap: 25,
        },
        {
          roles: ['*'],
          paths: [],
          types: ['lesson'],
          softCap: 15,
          hardCap: 25,
        },
        {
          roles: ['*'],
          paths: ['*'],
          types: ['lesson'],
          softCap: 10,
          hardCap: 20,
        },
      ]);

      const customCapParsed = MemoryConfigSchema.parse({
        repoId: 'cap-types-default',
        allowedRoles: ['general'],
        caps: [{ softCap: 5, hardCap: 10, roles: ['general'], paths: [] }],
      });
      expect(customCapParsed.caps[0]?.types).toEqual(['lesson']);

      const invalidCases: ReadonlyArray<Readonly<Record<string, unknown>>> = [
        {
          repoId: 'bad-cap',
          allowedRoles: ['general'],
          caps: [{ softCap: 10, hardCap: 5, roles: ['general'], paths: [] }],
        },
        {
          repoId: 'bad-autopush-no-remote',
          allowedRoles: ['general'],
          storage: {
            ledgerPath: '.memory/memory.jsonl',
            git: {
              enabled: true,
              checkoutDir: '.memory',
              branch: 'main',
              autoCommit: true,
              autoPush: true,
            },
          },
        },
        {
          repoId: 'bad-autopush-no-autocommit',
          allowedRoles: ['general'],
          storage: {
            ledgerPath: '.memory/memory.jsonl',
            git: {
              enabled: true,
              checkoutDir: '.memory',
              remoteUrl: 'https://example.com/memory.git',
              branch: 'main',
              autoCommit: false,
              autoPush: true,
            },
          },
        },
        {
          repoId: 'dup-allowed-roles',
          allowedRoles: ['general', 'builder', 'builder'],
        },
        {
          repoId: 'missing-general-role',
          allowedRoles: ['builder'],
        },
        {
          repoId: 'dup-cap-roles',
          allowedRoles: ['general', 'builder'],
          caps: [{ softCap: 5, hardCap: 10, roles: ['builder', 'builder'], paths: [] }],
        },
        {
          repoId: 'dup-cap-types',
          allowedRoles: ['general'],
          caps: [
            {
              softCap: 5,
              hardCap: 10,
              roles: ['general'],
              paths: [],
              types: ['lesson', 'lesson'],
            },
          ],
        },
        {
          repoId: 'mixed-wildcard-roles',
          allowedRoles: ['general', 'builder'],
          caps: [{ softCap: 5, hardCap: 10, roles: ['*', 'builder'], paths: [] }],
        },
        {
          repoId: 'unknown-cap-role',
          allowedRoles: ['general'],
          caps: [{ softCap: 5, hardCap: 10, roles: ['nonexistent'], paths: [] }],
        },
        {
          repoId: 'mixed-wildcard-paths',
          allowedRoles: ['general'],
          caps: [{ softCap: 5, hardCap: 10, roles: ['general'], paths: ['*', 'packages/a'] }],
        },
        {
          repoId: 'dot-slash-cap-path',
          allowedRoles: ['general'],
          caps: [{ softCap: 5, hardCap: 10, roles: ['general'], paths: ['./'] }],
        },
        {
          repoId: 'windows-drive-cap-path',
          allowedRoles: ['general'],
          caps: [{ softCap: 5, hardCap: 10, roles: ['general'], paths: ['C:/foo'] }],
        },
        {
          repoId: 'parent-traversal-cap-path',
          allowedRoles: ['general'],
          caps: [{ softCap: 5, hardCap: 10, roles: ['general'], paths: ['packages/../foo'] }],
        },
        {
          repoId: 'ledger-outside-checkout',
          allowedRoles: ['general'],
          storage: {
            ledgerPath: 'other-dir/memory.jsonl',
            git: {
              enabled: true,
              checkoutDir: '.memory',
              branch: 'main',
              autoCommit: true,
              autoPush: false,
              autoPullOnInit: true,
            },
          },
        },
        {
          repoId: 'invalid-forbid-regex',
          allowedRoles: ['general'],
          format: {
            forbidRegexes: ['[unclosed-group'],
          },
        },
      ];

      for (const badConfig of invalidCases) {
        await ws.writeConfig(badConfig, 'agents');
        expect(() => loadMemoryConfig(ws.workspaceRoot)).toThrowError(
          expect.objectContaining({
            code: 'CONFIG_VALIDATION_FAILED',
          }),
        );
      }
    } finally {
      await ws.cleanup();
    }
  });

  it('validates SessionIdSchema, DistillerStructuredOutputSchema, MemoryProposeOutputSchema, MemoryCommitInputSchema, and port contract types', () => {
    expect(SessionIdSchema.safeParse('session-123_abc.1').success).toBe(true);
    expect(SessionIdSchema.safeParse('latest-role').success).toBe(false);
    expect(SessionIdSchema.safeParse('../x').success).toBe(false);
    expect(SessionIdSchema.safeParse('a/b').success).toBe(false);
    expect(SessionIdSchema.safeParse('').success).toBe(false);

    expect(
      DistillerStructuredOutputSchema.safeParse({
        matchStatus: 'REJECTED_TIER_1_OR_2',
        recommendedChoiceIndex: -1,
        choices: [],
      }).success,
    ).toBe(false);

    expect(
      MemoryProposeOutputSchema.safeParse({
        executionMode: 'resolved',
        type: 'rule',
        requiresOwnerGo: true,
        bucketStatus: {
          bucketId: 'uncapped|type=rule|role=role:general|path=unscoped',
          currentCount: 0,
          bucketRecordIds: [],
          softCap: null,
          hardCap: null,
          zone: 'UNCAPPED',
          totalRecordsCount: 0,
          maxTotalRecords: null,
          maxTotalRecordsReached: false,
        },
        matchStatus: 'REJECTED_TIER_1_OR_2',
        tierRejectionReason: 'Rules cannot be rejected by Tier 1/2',
        recommendedChoiceIndex: -1,
        choices: [],
      }).success,
    ).toBe(false);

    expect(
      MemoryCommitInputSchema.safeParse({
        op: 'add',
        callerRole: 'builder',
        type: 'note',
        role: 'builder',
        text: 'Missing lifecycle on note',
      }).success,
    ).toBe(false);

    expect(
      MemoryCommitInputSchema.safeParse({
        op: 'update',
        callerRole: 'builder',
        id: 'L1',
        text: 'Do X when Y, because Z.',
        lifecycle: { mode: 'persistent' },
      }).success,
    ).toBe(false);

    const dummyRunner: MemoryDistillerRunner = {
      async runDistillerProposal(req: DistillerProposalRequest) {
        return {
          matchStatus: 'EXACT_DUPLICATE',
          recommendedChoiceIndex: req.timeoutMs > 0 ? -1 : 0,
          choices: [],
        };
      },
    };
    const dummyOptions: MemoryHarnessOptions = {
      workspaceRoot: '/tmp/ws',
      distillerRunner: dummyRunner,
    };
    const contractCheck: Partial<MemoryHarnessContract> = {};
    expect(dummyOptions.workspaceRoot).toBe('/tmp/ws');
    expect(contractCheck).toEqual({});
  });

  it('lists workspace files via git ls-files with tree-state caching inside a Git repo and falls back to tinyglobby outside a Git worktree', async () => {
    const nonGitWs = await createTempMemoryWorkspace({
      files: {
        'packages/alpha/src/index.ts': 'export const a = 1;\n',
        '.hidden/config.json': '{}\n',
        'node_modules/pkg/index.js': 'module.exports = {};\n',
        '.memory/.session-state/s1.json': '{}\n',
      },
    });
    try {
      const fallbackFiles = await listRepoFiles(nonGitWs.workspaceRoot);
      expect(fallbackFiles).toEqual([
        '.agents/memory.config.json',
        '.hidden/config.json',
        'packages/alpha/src/index.ts',
      ]);
    } finally {
      await nonGitWs.cleanup();
    }

    const gitWs = await createTempMemoryWorkspace({
      files: {
        'src/tracked.ts': 'export const tracked = true;\n',
      },
    });
    try {
      await execGitCommand({
        cwd: gitWs.workspaceRoot,
        useDashC: false,
        args: ['init', '-b', 'main', gitWs.workspaceRoot],
      });
      await execGitCommand({
        cwd: gitWs.workspaceRoot,
        args: ['add', 'src/tracked.ts'],
      });
      const firstList = await listRepoFiles(gitWs.workspaceRoot);
      expect(firstList).toEqual(['src/tracked.ts']);

      await gitWs.writeWorkspaceFile('src/untracked.ts', 'export const untracked = true;\n');
      const cachedSecondList = await listRepoFiles(gitWs.workspaceRoot);
      expect(cachedSecondList).toBe(firstList);
      expect(cachedSecondList).toEqual(['src/tracked.ts']);

      await execGitCommand({
        cwd: gitWs.workspaceRoot,
        args: ['add', 'src/untracked.ts'],
      });
      const invalidatedThirdList = await listRepoFiles(gitWs.workspaceRoot);
      expect(invalidatedThirdList).toEqual(['src/tracked.ts', 'src/untracked.ts']);
    } finally {
      await gitWs.cleanup();
    }
  });

  it('normalizes and deduplicates path and glob patterns via normalizeMemoryPathPattern and normalizeMemoryPathArray', () => {
    const root = '/Users/dev/project';
    expect(normalizeMemoryPathPattern('.', root)).toBe('**/*');
    expect(normalizeMemoryPathPattern('./', root)).toBe('**/*');
    expect(normalizeMemoryPathPattern('/Users/dev/project', root)).toBe('**/*');
    expect(normalizeMemoryPathPattern('/Users/dev/project/', root)).toBe('**/*');
    expect(normalizeMemoryPathPattern('/Users/dev/project/.', root)).toBe('**/*');
    expect(
      normalizeMemoryPathPattern('/Users/dev/project/./packages//lockfile/', root),
    ).toBe('packages/lockfile');
    expect(normalizeMemoryPathPattern('packages\\memory\\src\\*.ts', root)).toBe(
      'packages/memory/src/*.ts',
    );

    expect(() => normalizeMemoryPathPattern('   ', root)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    expect(() => normalizeMemoryPathPattern('/etc/passwd', root)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    expect(() => normalizeMemoryPathPattern('C:/Users/other/file.ts', root)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    expect(() => normalizeMemoryPathPattern('packages/../secret.ts', root)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    expect(() => normalizeMemoryPathPattern('packages/./file.ts', root)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );

    const deduped = normalizeMemoryPathArray(
      ['./packages/memory/', '/Users/dev/project/packages/memory', 'packages/lockfile/src/*.ts'],
      root,
    );
    expect(deduped).toEqual(['packages/memory', 'packages/lockfile/src/*.ts']);
  });

  it('enforces all 5 deterministic checks in validateLessonTextFormat and throws LESSON_FORMAT_INVALID on violations', () => {
    const cfg = MemoryConfigSchema.parse({
      repoId: 'format-test',
      allowedRoles: ['general'],
    });
    const validLesson =
      'Normalize incoming stream chunks to Buffer before passing to ReadBuffer, because string chunks lack subarray() and throw TypeError.';
    expect(validateLessonTextFormat(`  ${validLesson}  `, cfg.format)).toBe(validLesson);

    expect(() => validateLessonTextFormat('   ', cfg.format)).toThrowError(
      expect.objectContaining({ code: 'LESSON_FORMAT_INVALID' }),
    );
    expect(() => validateLessonTextFormat(`${'A'.repeat(505)}.`, cfg.format)).toThrowError(
      expect.objectContaining({ code: 'LESSON_FORMAT_INVALID' }),
    );
    expect(() =>
      validateLessonTextFormat(
        'Do something valid on line one,\nbecause line two has a newline character.',
        cfg.format,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LESSON_FORMAT_INVALID' }));
    expect(() =>
      validateLessonTextFormat(
        'Do something valid without a trailing period because it fails the period check',
        cfg.format,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LESSON_FORMAT_INVALID' }));
    expect(() =>
      validateLessonTextFormat(
        'First sentence ends here. Second sentence follows because single sentence is required.',
        cfg.format,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LESSON_FORMAT_INVALID' }));
    expect(() =>
      validateLessonTextFormat(
        'Always normalize path separators to POSIX forward slashes before matching globs.',
        cfg.format,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LESSON_FORMAT_INVALID' }));
    expect(() =>
      validateLessonTextFormat(
        'Do X because the mechanism clause is long enough.',
        cfg.format,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LESSON_FORMAT_INVALID' }));
    expect(() =>
      validateLessonTextFormat(
        'Always normalize path separators to POSIX forward slashes, because short.',
        cfg.format,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LESSON_FORMAT_INVALID' }));
    expect(() =>
      validateLessonTextFormat(
        'Validate input timestamps before parsing, because incident on 2026-11-09 broke prod.',
        cfg.format,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LESSON_FORMAT_INVALID' }));
    expect(() =>
      validateLessonTextFormat(
        'Validate input timestamps before parsing, because ticket TIC-1234 regressions recurred.',
        cfg.format,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LESSON_FORMAT_INVALID' }));
    expect(() =>
      validateLessonTextFormat(
        'Validate input timestamps before parsing, because pull request #42 failed in CI.',
        cfg.format,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LESSON_FORMAT_INVALID' }));
    expect(() =>
      validateLessonTextFormat(
        'Validate "quoted" input timestamps before parsing, because double quotes are forbidden.',
        cfg.format,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LESSON_FORMAT_INVALID' }));
  });

  it('evaluates all 4 symmetric cases of matchesContextScope including compound extensions, exact basenames, mid-segment globs, and isDirectoryCandidate guards', () => {
    const repoFiles = [
      'packages/lockfile/src/index.ts',
      'packages/lockfile/schema.sql',
      'packages/memory/src/schemas/memory-config.schema.ts',
      'packages/memory/src/internal/matches-context-scope.ts',
      '.agents/skills/peer/SKILL.md',
      'Makefile',
    ];

    expect(isGlobPattern('packages/lockfile/src/index.ts')).toBe(false);
    expect(isGlobPattern('packages/lockfile/**/*.ts')).toBe(true);
    expect(extractStaticDirPrefix('packages/memory/**/internal/*.ts')).toBe('packages/memory');
    expect(extractStaticDirPrefix('**/*.schema.ts')).toBe('');

    const schemaProbes = buildRelativeProbes('**/*.schema.ts');
    expect(schemaProbes).toContain('__probe__.schema.ts');
    expect(schemaProbes).toContain('__sub__/__probe__.schema.ts');

    expect(isDirectoryCandidate('Makefile', repoFiles)).toBe(false);
    expect(isDirectoryCandidate('packages/lockfile', repoFiles)).toBe(true);
    expect(isDirectoryCandidate('packages/unpopulated', repoFiles)).toBe(true);
    expect(isDirectoryCandidate('packages/unpopulated/file.ts', repoFiles)).toBe(false);

    expect(
      matchSingleContextPair('packages/lockfile', 'packages/lockfile/src/index.ts', repoFiles),
    ).toBe(true);
    expect(
      matchSingleContextPair('packages/lockfile/src/index.ts', 'packages/lockfile', repoFiles),
    ).toBe(true);
    expect(matchSingleContextPair('packages/lockfile', 'packages/lockfile-extra', repoFiles)).toBe(
      false,
    );

    expect(
      matchSingleContextPair(
        'packages/lockfile/src/index.ts',
        'packages/lockfile/**/*',
        repoFiles,
      ),
    ).toBe(true);
    expect(matchSingleContextPair('packages/lockfile', 'packages/lockfile/**/*.ts', [])).toBe(true);
    expect(matchSingleContextPair('packages/lockfile', '**/*.sql', repoFiles)).toBe(true);
    expect(matchSingleContextPair('packages/lockfile/src/index.ts', '**/*.sql', repoFiles)).toBe(
      false,
    );
    expect(matchSingleContextPair('packages', 'packages/lockfile/src/*.ts', repoFiles)).toBe(true);

    expect(
      matchSingleContextPair('packages/lockfile/**/*.ts', 'packages/lockfile', repoFiles),
    ).toBe(true);
    expect(matchSingleContextPair('**/*.sql', 'packages/lockfile', repoFiles)).toBe(true);

    expect(
      matchSingleContextPair('packages/memory/**', '**/*.schema.ts', []),
    ).toBe(true);
    expect(
      matchSingleContextPair('packages/memory/**', '**/SKILL.md', []),
    ).toBe(true);
    expect(
      matchSingleContextPair(
        'packages/memory/**/internal/*.ts',
        'packages/memory/src/**',
        [],
      ),
    ).toBe(true);
    expect(
      matchSingleContextPair('packages/lockfile/**/*.ts', 'packages/memory/**/*.ts', repoFiles),
    ).toBe(false);

    expect(
      matchesContextScope(
        ['packages/memory/src/schemas'],
        ['**/*.schema.ts'],
        repoFiles,
      ),
    ).toBe(true);
  });
});
