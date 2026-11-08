import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ASTNode } from '@metaharness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GitAbortMetaSchema,
  GitCowWorktreeScopeDriver,
  GitScopeReceiptSchema,
  GitSyncReceiptSchema,
  git,
} from '../src/index.js';
import { buildIsolatedWorktreeGitEnv } from '../src/executors/internal/git-cli-runner.js';
import { createTempGitHostRepo } from './fixtures/temp-git-host-repo.js';
import type { TempGitHostRepoHandle } from './fixtures/temp-git-host-repo-handle.js';

describe('git.cowWorktree builders, lockfileGate hydration, git-index checkpoints, and .git integrity', () => {
  let hostRepo: TempGitHostRepoHandle;

  beforeAll(async () => {
    hostRepo = await createTempGitHostRepo();
  });

  afterAll(async () => {
    await hostRepo.cleanup();
  });

  it('mounts schemas on git namespace and compiles GitCowWorktreeBuilder fluent methods to passive AST', () => {
    expect(git.ScopeReceiptSchema).toBe(GitScopeReceiptSchema);
    expect(git.SyncReceiptSchema).toBe(GitSyncReceiptSchema);
    expect(git.AbortMetaSchema).toBe(GitAbortMetaSchema);

    const setupCmd: ASTNode = Object.freeze({
      type: 'node:command',
      id: 'install-deps',
      argv: ['node', '-e', 'process.exit(0)'],
    });
    const checkNode = Object.freeze({
      type: 'git:clean-working-tree' as const,
      id: 'verify-check',
    });

    const builder = git
      .cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir })
      .excludeFromCloneGlobs(['dist/**', 'coverage/**'])
      .setup(setupCmd)
      .lockfileGate('pnpm-lock.yaml')
      .checkpointPolicy({
        excludeGlobs: ['**/*.tsbuildinfo'],
        maxUntrackedFileSizeBytes: 512,
      })
      .reconcileStrategy('rebase-onto-base', { verifyWith: checkNode, maxBatchSize: 4 });

    const ast = builder.toAST();
    expect(ast.type).toBe('git:cow-worktree');
    expect(ast.capabilityTier).toBe('branchable');
    expect(ast.supportsCheckpoints).toBe(true);
    expect(ast.supportsBranching).toBe(true);
    expect(ast.repo).toBe(hostRepo.repoPath);
    expect(ast.dir).toBe(hostRepo.worktreesDir);
    expect(ast.excludeFromCloneGlobs).toEqual(['dist/**', 'coverage/**']);
    expect(ast.lockfileGatePath).toBe('pnpm-lock.yaml');
    expect(ast.setupCommands).toHaveLength(1);
    expect(ast.checkpointPolicy?.maxUntrackedFileSizeBytes).toBe(512);
    expect(ast.reconcileStrategy).toEqual({
      mode: 'rebase-onto-base',
      verifyWith: checkNode,
      maxBatchSize: 4,
    });
    expect(ast.conflictCleanCheck).toEqual({
      type: 'git:clean-working-tree',
      id: 'git-clean-working-tree',
    });

    const objectOverloadAst = builder
      .reconcileStrategy({ mode: 'batch-merge-train', maxBatchSize: 3 })
      .toAST();
    expect(objectOverloadAst.reconcileStrategy?.mode).toBe('batch-merge-train');
    expect(objectOverloadAst.reconcileStrategy?.maxBatchSize).toBe(3);

    const sampleWorktreePath = path.join(hostRepo.worktreesDir, 'roots', 'run-env');
    const env = buildIsolatedWorktreeGitEnv(sampleWorktreePath);
    expect(env['GIT_CEILING_DIRECTORIES']).toBe(path.join(hostRepo.worktreesDir, 'roots'));
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(env['GIT_OPTIONAL_LOCKS']).toBe('0');
    expect(env['GIT_CONFIG_KEY_0']).toBe('commit.gpgsign');
    expect(env['GIT_CONFIG_VALUE_0']).toBe('false');
    expect(env['GIT_CONFIG_KEY_1']).toBe('core.hooksPath');
    expect(env['GIT_CONFIG_VALUE_1']).toBe('/dev/null');
  }, 20_000);

  it('hardlinks node_modules on lockfileGate hit and unlinks/replaces node_modules on lockfileGate miss before setup', async () => {
    const hostPkgFile = path.join(hostRepo.repoPath, 'node_modules', 'pkg-a', 'index.js');
    await mkdir(path.dirname(hostPkgFile), { recursive: true });
    await writeFile(hostPkgFile, 'module.exports = "host-original";\n', 'utf8');
    const hostInodeBefore = (await lstat(hostPkgFile)).ino;

    const setupScript =
      'const fs = require("node:fs"); fs.mkdirSync("node_modules/pkg-a", { recursive: true }); fs.writeFileSync("node_modules/pkg-a/index.js", "setup-replaced\\n");';
    const setupCmd: ASTNode = Object.freeze({
      type: 'node:command',
      id: 'hydrate-setup',
      argv: [process.execPath, '-e', setupScript],
    });

    const scopeNode = git
      .cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir })
      .lockfileGate('pnpm-lock.yaml')
      .setup(setupCmd)
      .toAST();
    const scope = new GitCowWorktreeScopeDriver(scopeNode);

    const hitHandle = await scope.acquireRoot('run-lock-hit');
    const hitPkgFile = path.join(hitHandle.worktreePath, 'node_modules', 'pkg-a', 'index.js');
    const hitStat = await lstat(hitPkgFile);
    expect(hitStat.ino).toBe(hostInodeBefore);
    expect(await readFile(hitPkgFile, 'utf8')).toBe('module.exports = "host-original";\n');
    await scope.release(hitHandle);

    await writeFile(
      path.join(hostRepo.repoPath, 'pnpm-lock.yaml'),
      'lockfileVersion: 9.0\npackages: { changed: true }\n',
      'utf8',
    );
    const missHandle = await scope.acquireRoot('run-lock-miss');
    const missPkgFile = path.join(missHandle.worktreePath, 'node_modules', 'pkg-a', 'index.js');
    const missStat = await lstat(missPkgFile);
    expect(missStat.ino).not.toBe(hostInodeBefore);
    expect(await readFile(missPkgFile, 'utf8')).toBe('setup-replaced\n');
    expect(await readFile(hostPkgFile, 'utf8')).toBe('module.exports = "host-original";\n');
    await scope.release(missHandle);
    await rm(path.join(hostRepo.repoPath, 'node_modules'), { recursive: true, force: true });
    await writeFile(
      path.join(hostRepo.repoPath, 'pnpm-lock.yaml'),
      'lockfileVersion: 9.0\npackages: {}\n',
      'utf8',
    );
  }, 20_000);

  it('serializes, diffs effects, and executes 4-step restore across tracked edits, deletions, symlinks, and oversized blobs', async () => {
    const scopeNode = git
      .cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir })
      .checkpointPolicy({ maxUntrackedFileSizeBytes: 64 })
      .toAST();
    const scope = new GitCowWorktreeScopeDriver(scopeNode);
    const handle = await scope.acquireRoot('run-ckpt-full');

    await writeFile(
      path.join(handle.worktreePath, 'src/index.ts'),
      'export const v = "ckpt-1";\n',
      'utf8',
    );
    const smallUntracked = path.join(handle.worktreePath, 'src/small.txt');
    await writeFile(smallUntracked, 'small-untracked', 'utf8');
    const oversizedUntracked = path.join(handle.worktreePath, 'assets/oversized.bin');
    await mkdir(path.dirname(oversizedUntracked), { recursive: true });
    const largeContent = 'X'.repeat(128);
    await writeFile(oversizedUntracked, largeContent, 'utf8');
    const symlinkPath = path.join(handle.worktreePath, 'src/link-readme');
    await symlink('../README.md', symlinkPath);

    const ckpt1 = await scope.serializeCheckpoint(handle);

    await writeFile(
      path.join(handle.worktreePath, 'src/index.ts'),
      'export const v = "mutated-after-ckpt";\n',
      'utf8',
    );
    await rm(path.join(handle.worktreePath, 'src/internal/helper.ts'));
    await mkdir(path.join(handle.worktreePath, 'src/internal/helper.ts'), { recursive: true });
    await writeFile(
      path.join(handle.worktreePath, 'src/internal/helper.ts/nested.ts'),
      'export const replacedByDir = true;\n',
      'utf8',
    );
    const ckptReplacedByDir = await scope.serializeCheckpoint(handle);
    await rm(oversizedUntracked);
    await rm(symlinkPath);
    await mkdir(symlinkPath, { recursive: true });
    await writeFile(path.join(symlinkPath, 'nested.txt'), 'collision', 'utf8');
    await writeFile(path.join(handle.worktreePath, 'extra/new-file.ts'), 'export const extra = 1;\n', {
      flag: 'w',
    }).catch(async () => {
      await mkdir(path.join(handle.worktreePath, 'extra'), { recursive: true });
      await writeFile(path.join(handle.worktreePath, 'extra/new-file.ts'), 'export const extra = 1;\n');
    });

    const effects = await scope.diffEffects(ckpt1, handle);
    expect(effects).toHaveLength(1);
    const fsEffect = effects[0];
    expect(fsEffect?.kind).toBe('fs:effect');
    expect(fsEffect?.mutatesScope).toBe(true);
    const effectPaths = (fsEffect?.attributes?.['paths'] as readonly string[]) ?? [];
    expect(effectPaths).toContain('src/index.ts');
    expect(effectPaths).toContain('src/internal/helper.ts');
    expect(effectPaths).toContain('src/internal/helper.ts/nested.ts');
    expect(effectPaths).toContain('extra/new-file.ts');

    await scope.restoreCheckpoint(handle, ckpt1);

    expect(await readFile(path.join(handle.worktreePath, 'src/index.ts'), 'utf8')).toBe(
      'export const v = "ckpt-1";\n',
    );
    expect(await readFile(path.join(handle.worktreePath, 'src/internal/helper.ts'), 'utf8')).toContain(
      'BASE_OFFSET',
    );
    expect(await readFile(oversizedUntracked, 'utf8')).toBe(largeContent);
    expect(await readlink(symlinkPath, 'utf8')).toBe('../README.md');
    const extraExists = await lstat(path.join(handle.worktreePath, 'extra/new-file.ts')).then(
      () => true,
      () => false,
    );
    expect(extraExists).toBe(false);
    const postRestoreEffects = await scope.diffEffects(ckpt1, handle);
    expect(postRestoreEffects).toHaveLength(0);

    await scope.restoreCheckpoint(handle, ckptReplacedByDir);
    expect(
      await readFile(path.join(handle.worktreePath, 'src/internal/helper.ts/nested.ts'), 'utf8'),
    ).toBe('export const replacedByDir = true;\n');
    await scope.restoreCheckpoint(handle, ckpt1);
    expect(await readFile(path.join(handle.worktreePath, 'src/internal/helper.ts'), 'utf8')).toContain(
      'BASE_OFFSET',
    );
    await scope.release(handle);
  }, 20_000);

  it('detects untracked files hidden behind .gitignore tampering and restores .gitignore rules', async () => {
    const scopeNode = git
      .cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir })
      .toAST();
    const scope = new GitCowWorktreeScopeDriver(scopeNode);
    const handle = await scope.acquireRoot('run-gitignore-tamper');

    const ckpt = await scope.serializeCheckpoint(handle);

    await writeFile(
      path.join(handle.worktreePath, '.gitignore'),
      'dist/\n*.log\nhidden-dir/\nsub/\n',
      'utf8',
    );
    await mkdir(path.join(handle.worktreePath, 'hidden-dir'), { recursive: true });
    await writeFile(
      path.join(handle.worktreePath, 'hidden-dir/secret-payload.txt'),
      'hidden',
      'utf8',
    );
    await mkdir(path.join(handle.worktreePath, 'sub'), { recursive: true });
    await writeFile(path.join(handle.worktreePath, 'sub/.gitignore'), '*\n', 'utf8');
    await writeFile(path.join(handle.worktreePath, 'sub/secret.txt'), 'sub-hidden', 'utf8');

    const effects = await scope.diffEffects(ckpt, handle);
    expect(effects).toHaveLength(1);
    const paths = (effects[0]?.attributes?.['paths'] as readonly string[]) ?? [];
    expect(paths).toContain('.gitignore');
    expect(paths).toContain('hidden-dir/secret-payload.txt');

    Object.assign(handle, { headRef: '0'.repeat(40) });
    await scope.restoreCheckpoint(handle, ckpt);
    expect(handle.headRef).toBe(handle.baseRef);
    expect(await readFile(path.join(handle.worktreePath, '.gitignore'), 'utf8')).toBe(
      'dist/\n*.log\n',
    );
    const hiddenStillExists = await lstat(
      path.join(handle.worktreePath, 'hidden-dir/secret-payload.txt'),
    ).then(
      () => true,
      () => false,
    );
    expect(hiddenStillExists).toBe(false);
    const subGitignoreExists = await lstat(
      path.join(handle.worktreePath, 'sub/.gitignore'),
    ).then(
      () => true,
      () => false,
    );
    expect(subGitignoreExists).toBe(false);
    const subSecretExists = await lstat(path.join(handle.worktreePath, 'sub/secret.txt')).then(
      () => true,
      () => false,
    );
    expect(subSecretExists).toBe(false);
    await scope.release(handle);
  }, 20_000);

  it('rolls back to fromCheckpoint and throws on worktree-local .git metadata or node_modules tampering across multiple checkpoints', async () => {
    const scopeNode = git
      .cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir })
      .toAST();
    const scope = new GitCowWorktreeScopeDriver(scopeNode);
    const handle = await scope.acquireRoot('run-git-integrity');

    const nmFile = path.join(handle.worktreePath, 'node_modules', 'guarded-pkg', 'index.js');
    await mkdir(path.dirname(nmFile), { recursive: true });
    await writeFile(nmFile, 'export const safe = 1;\n', 'utf8');

    const ckpt = await scope.serializeCheckpoint(handle);

    await writeFile(nmFile, 'export const safe = 2;\n', 'utf8');
    const ckpt2 = await scope.serializeCheckpoint(handle);

    await scope.restoreCheckpoint(handle, ckpt);
    expect(await readFile(nmFile, 'utf8')).toBe('export const safe = 1;\n');

    await scope.restoreCheckpoint(handle, ckpt2);
    expect(await readFile(nmFile, 'utf8')).toBe('export const safe = 2;\n');

    await scope.restoreCheckpoint(handle, ckpt);
    expect(await readFile(nmFile, 'utf8')).toBe('export const safe = 1;\n');

    await mkdir(path.join(handle.gitDirPath, 'info'), { recursive: true });
    await writeFile(path.join(handle.gitDirPath, 'info', 'exclude'), '*.tampered\n', 'utf8');
    await writeFile(path.join(handle.worktreePath, 'src/index.ts'), '// tampered\n', 'utf8');

    await expect(scope.diffEffects(ckpt, handle)).rejects.toThrow(/integrity violation/);
    expect(await readFile(path.join(handle.worktreePath, 'src/index.ts'), 'utf8')).toContain(
      'export function add',
    );

    await writeFile(nmFile, 'export const safe = 999;\n', 'utf8');
    await expect(scope.diffEffects(ckpt, handle)).rejects.toThrow(/integrity violation/);
    expect(await readFile(nmFile, 'utf8')).toBe('export const safe = 1;\n');

    await scope.release(handle);
  }, 20_000);
});
