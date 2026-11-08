import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { M, type ResolutionContext, extractAST } from '@metaharness/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeMarkdownFrontmatterSource,
  executeMarkdownSectionSource,
  extractMarkdownHeadingSection,
  markdownExecutors,
  md,
  parseMarkdownFrontmatter,
} from '../src/index.js';

function createResolutionContext(): ResolutionContext {
  return Object.freeze<ResolutionContext>({
    runId: 'run-md-test',
    activePartitions: Object.freeze(['db', 'api']),
    observedEffects: Object.freeze([]),
    scopeHandle: undefined,
    resolveEnv: () => '',
  });
}

async function writeTempMarkdownFiles(
  rootDir: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(rootDir, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, 'utf8');
  }
}

describe('@metaharness/markdown builders, parser, and executors', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    }
  });

  it('constructs passive AST nodes with deterministic kind and id discriminators', () => {
    const globalBuilder = md.globalRules('.harness/rules/global/*.md');
    expect(globalBuilder.kind).toBe('global-rules');
    expect(globalBuilder.id).toBe('md:global-rules:.harness/rules/global/*.md');
    expect(extractAST(globalBuilder)).toEqual({
      type: 'markdown:frontmatter',
      id: 'md:global-rules:.harness/rules/global/*.md',
      pathOrGlob: '.harness/rules/global/*.md',
      kind: 'global-rules',
    });

    const scopedRuleBuilder = md.scopedRule('.harness/rules/db-migrations.md');
    expect(scopedRuleBuilder.kind).toBe('scoped-rule');
    expect(scopedRuleBuilder.id).toBe('md:scoped-rule:.harness/rules/db-migrations.md');

    const scopedRulesBuilder = md.scopedRules('.harness/rules/scoped/**/*.md');
    expect(scopedRulesBuilder.kind).toBe('scoped-rules');
    expect(scopedRulesBuilder.id).toBe('md:scoped-rules:.harness/rules/scoped/**/*.md');

    const skillBuilder = md.skill('.harness/skills/db-migrations/SKILL.md');
    expect(skillBuilder.kind).toBe('skill');
    expect(skillBuilder.id).toBe('md:skill:.harness/skills/db-migrations/SKILL.md');

    const skillsBuilder = md.skills('.harness/skills/shared/*.md');
    expect(skillsBuilder.kind).toBe('skills');
    expect(skillsBuilder.id).toBe('md:skills:.harness/skills/shared/*.md');

    const fmBuilder = md.frontmatter('.harness/custom/config.md');
    expect(fmBuilder.kind).toBe('frontmatter');
    expect(fmBuilder.id).toBe('md:frontmatter:.harness/custom/config.md');

    const sectionBuilder = md.section('TECH_DESIGN.md', 'Architecture Overview');
    expect(extractAST(sectionBuilder)).toEqual({
      type: 'markdown:section',
      id: 'md:section:TECH_DESIGN.md#Architecture Overview',
      path: 'TECH_DESIGN.md',
      heading: 'Architecture Overview',
    });

    expect(markdownExecutors.sources?.['markdown:frontmatter']).toBe(
      executeMarkdownFrontmatterSource,
    );
    expect(markdownExecutors.sources?.['markdown:section']).toBe(executeMarkdownSectionSource);
  });

  it('parses YAML frontmatter scalars, flow arrays with braces, nested maps, block scalars, and heading sections ignoring code block hashes', () => {
    const rawDoc = [
      '---',
      'id: db-migration-safety',
      'enabled: true',
      'priority: 10',
      'partitions: [db, api]',
      'globs: ["packages/{db,api}/migrations/*.sql", "packages/db/src/schema.ts"]',
      'metadata:',
      '  owner: platform',
      '  tags:',
      '    - safety',
      '    - ddl',
      'summary: |',
      '  Multi-line block scalar',
      '  preserving internal newlines.',
      '---',
      '# Migration Overview',
      'Intro paragraph.',
      '## Safety Checklist',
      '1. Never drop columns without dual-write.',
      '```bash',
      '# Bash comment that must not terminate the heading section',
      '## Secondary bash comment inside fenced code block',
      'psql -c "SELECT 1;"',
      '```',
      '### Sub-check',
      'Verify locks.',
      '## Rollback Plan',
      'Restore snapshot.',
    ].join('\n');

    const parsed = parseMarkdownFrontmatter(rawDoc);
    expect(parsed.frontmatter).toEqual({
      id: 'db-migration-safety',
      enabled: true,
      priority: 10,
      partitions: ['db', 'api'],
      globs: ['packages/{db,api}/migrations/*.sql', 'packages/db/src/schema.ts'],
      metadata: {
        owner: 'platform',
        tags: ['safety', 'ddl'],
      },
      summary: 'Multi-line block scalar\npreserving internal newlines.\n',
    });
    expect(parsed.body).toContain('# Migration Overview');

    const safetySection = extractMarkdownHeadingSection(rawDoc, 'Safety Checklist');
    expect(safetySection).toBe(
      [
        '1. Never drop columns without dual-write.',
        '```bash',
        '# Bash comment that must not terminate the heading section',
        '## Secondary bash comment inside fenced code block',
        'psql -c "SELECT 1;"',
        '```',
        '### Sub-check',
        'Verify locks.',
      ].join('\n'),
    );
  });

  it('executes globalRules, scopedRule, and scopedRules with passive fs:match-globs translation', async () => {
    const rawTmp = await mkdtemp(join(tmpdir(), 'harness-md-test-'));
    const rootDir = await realpath(rawTmp);
    tempDirs.push(rootDir);

    await writeTempMarkdownFiles(rootDir, {
      'rules/global/01-strict-types.md': [
        '---',
        'id: strict-types',
        '---',
        'Zero any casts in production code.',
      ].join('\n'),
      'rules/global/02-jsdoc.md': [
        '---',
        'id: complete-jsdoc',
        '---',
        'Document every exported declaration.',
      ].join('\n'),
      'rules/scoped/db-migrations.md': [
        '---',
        'id: db-migrations',
        'partitions: [db]',
        'globs:',
        '  - "packages/db/migrations/*.sql"',
        '---',
        'Run migrations inside an advisory lock.',
      ].join('\n'),
      'rules/scoped/api-handlers.md': [
        '---',
        'id: api-handlers',
        'partitions: [api]',
        'globs: ["packages/api/src/**/*.ts"]',
        '---',
        'Validate all route inputs with Zod.',
      ].join('\n'),
    });

    const ctx = createResolutionContext();
    const globalArtifact = await executeMarkdownFrontmatterSource(
      md.globalRules(`${rootDir}/rules/global/*.md`),
      undefined,
      ctx,
    );
    expect(globalArtifact.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(globalArtifact.content).toEqual([
      { id: 'strict-types', directive: 'Zero any casts in production code.' },
      { id: 'complete-jsdoc', directive: 'Document every exported declaration.' },
    ]);

    const singleScopedArtifact = await executeMarkdownFrontmatterSource(
      md.scopedRule(`${rootDir}/rules/scoped/db-migrations.md`),
      undefined,
      ctx,
    );
    expect(singleScopedArtifact.content).toEqual({
      id: 'db-migrations',
      when: {
        partitions: ['db'],
        effects: {
          type: 'fs:match-globs',
          id: 'fs:match-globs:write:packages/db/migrations/*.sql',
          globs: ['packages/db/migrations/*.sql'],
          mode: 'write',
        },
      },
      directive: 'Run migrations inside an advisory lock.',
      checks: [],
    });

    const multiScopedArtifact = await executeMarkdownFrontmatterSource(
      md.scopedRules(`${rootDir}/rules/scoped/*.md`),
      undefined,
      ctx,
    );
    expect(multiScopedArtifact.content).toHaveLength(2);
    expect(multiScopedArtifact.content[0]?.id).toBe('api-handlers');
    expect(multiScopedArtifact.content[1]?.id).toBe('db-migrations');

    const rulesAst = M.rules('repo-rules')
      .global(md.globalRules(`${rootDir}/rules/global/*.md`))
      .scoped(
        md.scopedRules(`${rootDir}/rules/scoped/*.md`),
        M.scopedRule(md.scopedRule(`${rootDir}/rules/scoped/db-migrations.md`)),
      )
      .toAST();
    expect(rulesAst.globalRules).toHaveLength(1);
    expect(rulesAst.scopedRules).toHaveLength(2);

    const dirGlobalArtifact = await executeMarkdownFrontmatterSource(
      md.globalRules(`${rootDir}/rules/global`),
      undefined,
      ctx,
    );
    expect(dirGlobalArtifact.content).toEqual([
      { id: 'strict-types', directive: 'Zero any casts in production code.' },
      { id: 'complete-jsdoc', directive: 'Document every exported declaration.' },
    ]);

    const braceAndCharClassArtifact = await executeMarkdownFrontmatterSource(
      md.scopedRules(`${rootDir}/rules/{scoped,missing}/[a-d]*.md`),
      undefined,
      ctx,
    );
    expect(braceAndCharClassArtifact.content.map((r) => r.id)).toEqual([
      'api-handlers',
      'db-migrations',
    ]);

    const missingDirGlobArtifact = await executeMarkdownFrontmatterSource(
      md.globalRules(`${rootDir}/rules/nonexistent-subdir/*.md`),
      undefined,
      ctx,
    );
    expect(missingDirGlobArtifact.content).toEqual([]);
  });

  it('executes md.skill, md.skills, md.frontmatter (including id-prefix fallback), and md.section', async () => {
    const rawTmp = await mkdtemp(join(tmpdir(), 'harness-md-skills-'));
    const rootDir = await realpath(rawTmp);
    tempDirs.push(rootDir);

    await writeTempMarkdownFiles(rootDir, {
      'skills/db-migrations.md': [
        '---',
        'id: db-migrations-skill',
        'description: Run and verify Drizzle schema migrations safely.',
        'partitions: [db]',
        'globs: ["packages/db/migrations/*.sql"]',
        '---',
        'Step 1: Generate migration.\nStep 2: Apply against localPostgres.',
      ].join('\n'),
      'docs/ARCHITECTURE.md': [
        '---',
        'owner: platform-team',
        'version: 2',
        '---',
        '# System Architecture',
        'High-level overview.',
        '## Isolation Scopes',
        'All workers execute inside copy-on-write git worktrees.',
        '## Prefix Caching',
        'Slot 1 remains byte-identical across turns.',
      ].join('\n'),
    });

    const ctx = createResolutionContext();
    const skillArtifact = await executeMarkdownFrontmatterSource(
      md.skill(`${rootDir}/skills/db-migrations.md`),
      undefined,
      ctx,
    );
    expect(skillArtifact.content).toEqual({
      type: 'harness:skill',
      id: 'db-migrations-skill',
      source: undefined,
      when: {
        partitions: ['db'],
        effects: {
          type: 'fs:match-globs',
          id: 'fs:match-globs:write:packages/db/migrations/*.sql',
          globs: ['packages/db/migrations/*.sql'],
          mode: 'write',
        },
      },
      description: 'Run and verify Drizzle schema migrations safely.',
      instructions: 'Step 1: Generate migration.\nStep 2: Apply against localPostgres.',
      unlockedTools: [],
      unlockedServices: [],
      leaseMode: 'until-completed-or-fork-exit',
    });

    const skillsBundle = await executeMarkdownFrontmatterSource(
      md.skills(`${rootDir}/skills/*.md`),
      undefined,
      ctx,
    );
    expect(skillsBundle.content).toHaveLength(1);
    expect(skillsBundle.content[0]?.id).toBe('db-migrations-skill');

    const fallbackIdNode = Object.freeze({
      type: 'markdown:frontmatter' as const,
      id: `md:skill:${rootDir}/skills/db-migrations.md`,
      pathOrGlob: `${rootDir}/skills/db-migrations.md`,
    });
    const fallbackSkill = await executeMarkdownFrontmatterSource(fallbackIdNode, undefined, ctx);
    expect(fallbackSkill.content).toMatchObject({
      type: 'harness:skill',
      id: 'db-migrations-skill',
    });

    const fmArtifact = await executeMarkdownFrontmatterSource(
      md.frontmatter<{ readonly owner: string; readonly version: number }>(
        `${rootDir}/docs/ARCHITECTURE.md`,
      ),
      undefined,
      ctx,
    );
    expect(fmArtifact.content.owner).toBe('platform-team');
    expect(fmArtifact.content.version).toBe(2);

    const sectionArtifact = await executeMarkdownSectionSource(
      md.section(`${rootDir}/docs/ARCHITECTURE.md`, 'Isolation Scopes'),
      undefined,
      ctx,
    );
    expect(sectionArtifact.content).toBe(
      'All workers execute inside copy-on-write git worktrees.',
    );
    expect(sectionArtifact.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
