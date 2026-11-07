import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type NodeRunnerNode,
  type ResolutionContext,
  type StepExecutionContext,
  createExecutorRegistry,
} from '@harness-dsl/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FsToolEffect,
  createFsEditToolDriver,
  createFsGlobToolDriver,
  createFsGrepToolDriver,
  createFsReadToolDriver,
  createFsWriteToolDriver,
  executeFsGlobSource,
  executeFsTextSource,
  fs,
  fsExecutors,
} from '../src/index.js';
import type { TempFsWorkspaceHandle } from './fixtures/temp-fs-workspace-handle.js';
import { createTempFsWorkspace } from './fixtures/temp-fs-workspace.js';

const dummyRunner: NodeRunnerNode = Object.freeze({
  type: 'node:runner',
  id: 'node:runner:test',
  slots: 4,
  maxDaemons: 2,
});

function createStepContext(worktreePath: string, baseRef = 'HEAD'): StepExecutionContext {
  return Object.freeze<StepExecutionContext>({
    runId: 'run-fs-test',
    stepExecId: 'step-1',
    activePartitions: Object.freeze(['core']),
    activeLeases: Object.freeze([]),
    observedEffects: Object.freeze([]),
    scopeHandle: Object.freeze({
      worktreePath,
      branchName: 'harness/test',
      baseRef,
      baseBranch: 'main',
    }),
    signal: new AbortController().signal,
    resolveEnv: () => '',
    getRunner: () => {
      throw new Error('Runner not used by native fs tools');
    },
    recordEffects: () => {},
    registry: createExecutorRegistry([fsExecutors]),
  });
}

describe('@harness-dsl/fs tools and sources', () => {
  const workspaces: TempFsWorkspaceHandle[] = [];
  const extraDirs: string[] = [];

  afterEach(async () => {
    while (workspaces.length > 0) {
      const ws = workspaces.pop();
      if (ws !== undefined) await ws.cleanup();
    }
    while (extraDirs.length > 0) {
      const dir = extraDirs.pop();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    }
  });

  it('constructs passive codingTools and readOnlyTools tuples and registers all executors', () => {
    const coding = fs.codingTools(dummyRunner);
    expect(coding.map((t) => t.type)).toEqual([
      'fs:read',
      'fs:edit',
      'fs:write',
      'fs:glob',
      'fs:grep',
    ]);
    expect(coding.map((t) => t.name)).toEqual([
      'read_file',
      'edit_file',
      'write_file',
      'glob_files',
      'grep_files',
    ]);
    for (const tool of coding) {
      expect(tool.effectTracking).toBe('declared');
      expect(fsExecutors.tools?.[tool.type]).toBeDefined();
    }

    const readOnly = fs.readOnlyTools(dummyRunner);
    expect(readOnly.map((t) => t.type)).toEqual(['fs:read', 'fs:glob', 'fs:grep']);
  });

  it('executes read_file, glob_files, and grep_files inside the workspace', async () => {
    const ws = await createTempFsWorkspace({
      files: {
        'src/alpha.ts': 'export const ALPHA = 1;\nexport const BETA = 2;\n',
        'src/nested/gamma.ts': 'export const GAMMA = "needle";\n',
        'node_modules/pkg/index.js': 'export const IGNORED = "needle";\n',
      },
    });
    workspaces.push(ws);
    const [readNode, , , globNode, grepNode] = fs.codingTools(dummyRunner);
    const ctx = createStepContext(ws.rootDir);

    const readDriver = createFsReadToolDriver();
    const readEffects = (readDriver.describeEffects?.(
      readNode,
      { path: 'src/alpha.ts' },
      ctx.scopeHandle,
    ) ?? []) as readonly FsToolEffect[];
    expect(readEffects).toEqual([
      {
        kind: 'fs:effect',
        mutatesScope: false,
        attributes: {
          mode: 'read',
          paths: ['src/alpha.ts'],
          existingPathsAtBaseRef: undefined,
          proposedContent: undefined,
        },
      },
    ]);
    const readRes = await readDriver.execute(readNode, { path: 'src/alpha.ts' }, ctx);
    expect(readRes.content).toBe('export const ALPHA = 1;\nexport const BETA = 2;\n');

    const globDriver = createFsGlobToolDriver();
    const globRes = await globDriver.execute(
      globNode,
      { pattern: 'src/{nested,other}/*.ts' },
      ctx,
    );
    expect(globRes.content).toBe('src/nested/gamma.ts');
    const allSrcGlobRes = await globDriver.execute(globNode, { pattern: 'src/**/*.ts' }, ctx);
    expect(allSrcGlobRes.content).toBe('src/alpha.ts\nsrc/nested/gamma.ts');

    const grepDriver = createFsGrepToolDriver();
    const grepRes = await grepDriver.execute(grepNode, { pattern: 'needle' }, ctx);
    expect(grepRes.content).toBe('src/nested/gamma.ts:1:export const GAMMA = "needle";');
  });

  it('executes write_file and edit_file and populates existingPathsAtBaseRef and proposedContent', async () => {
    const ws = await createTempFsWorkspace({
      files: {
        'src/existing.ts': 'export const count = 1;\n',
      },
      initGit: true,
    });
    workspaces.push(ws);
    const [, editNode, writeNode] = fs.codingTools(dummyRunner);
    const ctx = createStepContext(ws.rootDir, ws.baseRef);

    const editDriver = createFsEditToolDriver();
    const editEffects = (editDriver.describeEffects?.(
      editNode,
      {
        path: 'src/existing.ts',
        oldString: 'count = 1',
        newString: 'count = 42',
      },
      ctx.scopeHandle,
    ) ?? []) as readonly FsToolEffect[];
    expect(editEffects).toEqual([
      {
        kind: 'fs:effect',
        mutatesScope: true,
        attributes: {
          mode: 'write',
          paths: ['src/existing.ts'],
          existingPathsAtBaseRef: ['src/existing.ts'],
          proposedContent: {
            'src/existing.ts': 'export const count = 42;\n',
          },
        },
      },
    ]);

    const editRes = await editDriver.execute(
      editNode,
      {
        path: 'src/existing.ts',
        oldString: 'count = 1',
        newString: 'count = 42',
      },
      ctx,
    );
    expect(editRes.content).toContain('Edited src/existing.ts');
    expect(await readFile(join(ws.rootDir, 'src/existing.ts'), 'utf8')).toBe(
      'export const count = 42;\n',
    );

    const writeDriver = createFsWriteToolDriver();
    const writeEffects = (writeDriver.describeEffects?.(
      writeNode,
      {
        path: 'src/brand-new.ts',
        content: 'export const created = true;\n',
      },
      ctx.scopeHandle,
    ) ?? []) as readonly FsToolEffect[];
    expect(writeEffects).toEqual([
      {
        kind: 'fs:effect',
        mutatesScope: true,
        attributes: {
          mode: 'write',
          paths: ['src/brand-new.ts'],
          existingPathsAtBaseRef: [],
          proposedContent: {
            'src/brand-new.ts': 'export const created = true;\n',
          },
        },
      },
    ]);

    await writeDriver.execute(
      writeNode,
      { path: 'src/brand-new.ts', content: 'export const created = true;\n' },
      ctx,
    );
    expect(await readFile(join(ws.rootDir, 'src/brand-new.ts'), 'utf8')).toBe(
      'export const created = true;\n',
    );

    const dollarReplacement = 'cost = "$$100 ($& / $` / $\')"';
    const dollarEditEffects = (editDriver.describeEffects?.(
      editNode,
      {
        path: 'src/existing.ts',
        oldString: 'count = 42',
        newString: dollarReplacement,
      },
      ctx.scopeHandle,
    ) ?? []) as readonly FsToolEffect[];
    expect(dollarEditEffects[0]?.attributes.proposedContent?.['src/existing.ts']).toBe(
      `export const ${dollarReplacement};\n`,
    );
    await editDriver.execute(
      editNode,
      {
        path: 'src/existing.ts',
        oldString: 'count = 42',
        newString: dollarReplacement,
      },
      ctx,
    );
    expect(await readFile(join(ws.rootDir, 'src/existing.ts'), 'utf8')).toBe(
      `export const ${dollarReplacement};\n`,
    );
  });

  it('blocks path traversal, realpath symlink escapes, and node_modules writes', async () => {
    const outsideRaw = await mkdtemp(join(tmpdir(), 'harness-outside-'));
    const outsideDir = await realpath(outsideRaw);
    extraDirs.push(outsideDir);
    const secretFile = join(outsideDir, 'secret.txt');
    await writeFile(secretFile, 'top-secret', 'utf8');
    const outsideNonexistentDir = join(outsideDir, 'dangling-outside-target');

    const ws = await createTempFsWorkspace({
      files: {
        'src/ok.ts': 'ok',
        'linked-target/inside.ts': 'export const LINKED = "linked-needle";\n',
      },
      symlinks: {
        'src/escape-file.txt': secretFile,
        'src/escape-dir': outsideDir,
        'src/dangling-hop2': outsideNonexistentDir,
        'src/dangling-hop1': 'dangling-hop2',
        'src/linked-dir': '../linked-target',
      },
    });
    workspaces.push(ws);
    await symlink(ws.rootDir, join(ws.rootDir, 'linked-target/cycle-root'));
    const [readNode, editNode, writeNode, globNode, grepNode] = fs.codingTools(dummyRunner);
    const ctx = createStepContext(ws.rootDir);

    const readDriver = createFsReadToolDriver();
    await expect(readDriver.execute(readNode, { path: '../outside.txt' }, ctx)).rejects.toThrow(
      /escapes worktree/,
    );
    await expect(readDriver.execute(readNode, { path: 'src/escape-file.txt' }, ctx)).rejects.toThrow(
      /escapes worktree/,
    );

    const writeDriver = createFsWriteToolDriver();
    await expect(
      writeDriver.execute(writeNode, { path: 'src/escape-dir/pwn.txt', content: 'x' }, ctx),
    ).rejects.toThrow(/escapes worktree/);
    await expect(
      writeDriver.execute(
        writeNode,
        { path: 'src/dangling-hop1/sub/pwn.txt', content: 'x' },
        ctx,
      ),
    ).rejects.toThrow(/escapes worktree/);
    expect(existsSync(outsideNonexistentDir)).toBe(false);

    await writeDriver.execute(writeNode, { path: '..env', content: 'VALID_DOTDOT_NAME=1\n' }, ctx);
    const dotDotRead = await readDriver.execute(readNode, { path: '..env' }, ctx);
    expect(dotDotRead.content).toBe('VALID_DOTDOT_NAME=1\n');

    const globDriver = createFsGlobToolDriver();
    const linkedGlobRes = await globDriver.execute(
      globNode,
      { pattern: 'src/linked-dir/**/*.ts' },
      ctx,
    );
    expect(linkedGlobRes.content).toBe('src/linked-dir/inside.ts');

    const grepDriver = createFsGrepToolDriver();
    const linkedGrepRes = await grepDriver.execute(
      grepNode,
      { pattern: 'linked-needle', glob: 'src/linked-dir/**/*.ts' },
      ctx,
    );
    expect(linkedGrepRes.content).toBe(
      'src/linked-dir/inside.ts:1:export const LINKED = "linked-needle";',
    );

    await expect(
      writeDriver.execute(writeNode, { path: 'node_modules/pkg/index.js', content: 'x' }, ctx),
    ).rejects.toThrow(/node_modules/);
    await expect(
      writeDriver.execute(
        writeNode,
        { path: 'packages/web/node_modules/pkg/a.js', content: 'x' },
        ctx,
      ),
    ).rejects.toThrow(/node_modules/);

    const editDriver = createFsEditToolDriver();
    expect(() =>
      editDriver.describeEffects?.(
        editNode,
        { path: 'node_modules/pkg/index.js', oldString: 'a', newString: 'b' },
        ctx.scopeHandle,
      ),
    ).toThrow(/node_modules/);
  });

  it('resolves fs.text and fs.glob against host root when scopeHandle is omitted and worktreePath when provided', async () => {
    const ws = await createTempFsWorkspace({
      files: {
        'SPEC_DOC.md': 'Worktree version of spec',
        'docs/a.md': 'Doc A',
        'docs/b.md': 'Doc B',
      },
    });
    workspaces.push(ws);

    const hostCtx: ResolutionContext = Object.freeze({
      runId: 'run-source',
      activePartitions: Object.freeze([]),
      observedEffects: Object.freeze([]),
      scopeHandle: undefined,
      resolveEnv: () => '',
    });
    const hostPackageJson = await executeFsTextSource(fs.text('package.json'), undefined, hostCtx);
    expect(hostPackageJson.content).toContain('@harness-dsl');
    expect(hostPackageJson.digest).toMatch(/^[a-f0-9]{64}$/);

    const worktreeCtx: ResolutionContext = Object.freeze({
      ...hostCtx,
      scopeHandle: Object.freeze({ worktreePath: ws.rootDir }),
    });
    const worktreeSpec = await executeFsTextSource(fs.text('SPEC_DOC.md'), undefined, worktreeCtx);
    expect(worktreeSpec.content).toBe('Worktree version of spec');

    const globArtifact = await executeFsGlobSource(fs.glob('docs/*.md'), undefined, worktreeCtx);
    expect(globArtifact.content).toEqual([
      { path: 'docs/a.md', content: 'Doc A' },
      { path: 'docs/b.md', content: 'Doc B' },
    ]);
    expect(globArtifact.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
