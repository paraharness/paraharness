import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StepExecutionContext, GitWorktreeHandle } from '@paraharness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GitCowWorktreeScopeDriver,
  executeGitCleanWorkingTreeCheck,
  executeGitPatchEquivalence,
  git,
} from '../src/index.js';
import {
  readHarnessMeta,
  runGitCommand,
  writeHarnessMeta,
} from '../src/executors/internal/git-cli-runner.js';
import { extractRelativeImports } from '../src/executors/internal/git-cross-test-import-scanner.js';
import { createTempGitHostRepo } from './fixtures/temp-git-host-repo.js';
import type { TempGitHostRepoHandle } from './fixtures/temp-git-host-repo-handle.js';

function createMockStepCtx(handle: GitWorktreeHandle): StepExecutionContext<GitWorktreeHandle> {
  return {
    runId: 'run-reconcile',
    stepExecId: 'step-1',
    scopeHandle: handle,
    activePartitions: [],
    activeLeases: [],
    observedEffects: [],
    resolveEnv: (v) => (typeof v === 'string' ? v : undefined),
    getRunner: () => ({
      id: 'mock-runner',
      withSlot: (fn) => fn(),
      withDaemonSlot: (fn) => fn(() => undefined),
    }),
    recordEffects: () => undefined,
    registry: {} as StepExecutionContext<GitWorktreeHandle>['registry'],
  };
}

describe('git.cowWorktree forkChild, inspect ref pinning, stateless 3-way merge-tree, and crash reattachment', () => {
  let hostRepo: TempGitHostRepoHandle;

  beforeAll(async () => {
    hostRepo = await createTempGitHostRepo();
  });

  afterAll(async () => {
    await hostRepo.cleanup();
  });

  it('auto-flushes parent dirty edits before forkChild, inspects non-mutatingly, and pins candidate and completed refs', async () => {
    const scopeNode = git
      .cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir })
      .toAST();
    const scope = new GitCowWorktreeScopeDriver(scopeNode);
    const root = await scope.acquireRoot('run-fork-pin');
    const initialBaseRef = root.baseRef;

    await writeFile(
      path.join(root.worktreePath, 'src/parent-note.md'),
      'Parent note\n=======\nSection body\n',
      'utf8',
    );

    const [child0, child1] = await Promise.all([
      scope.forkChild(root, 'call-1:branch:0'),
      scope.forkChild(root, 'call-1:branch:1'),
    ]);

    expect(root.baseRef).toBe(initialBaseRef);
    expect(root.headRef).not.toBe(initialBaseRef);
    expect(await readFile(path.join(child0.worktreePath, 'src/parent-note.md'), 'utf8')).toContain(
      'Section body',
    );
    expect(await readFile(path.join(child1.worktreePath, 'src/parent-note.md'), 'utf8')).toContain(
      'Section body',
    );

    await writeFile(
      path.join(child0.worktreePath, 'src/candidate0.ts'),
      'export const c0 = true;\n',
      'utf8',
    );
    const headBeforeInspect = (
      await runGitCommand({ cwd: child0.worktreePath, args: ['rev-parse', 'HEAD'] })
    ).stdout.trim();
    const receipt0 = await scope.inspect(child0);
    const headAfterInspect = (
      await runGitCommand({ cwd: child0.worktreePath, args: ['rev-parse', 'HEAD'] })
    ).stdout.trim();

    expect(headAfterInspect).toBe(headBeforeInspect);
    expect(receipt0.mutatedFiles).toContain('src/candidate0.ts');
    const pinnedCandidate = (
      await runGitCommand({
        cwd: hostRepo.repoPath,
        args: ['rev-parse', 'refs/harness/candidates/run-fork-pin/0'],
      })
    ).stdout.trim();
    expect(pinnedCandidate).toBe(receipt0.headRef);

    const cleanCheckRes = await executeGitCleanWorkingTreeCheck(
      { type: 'git:clean-working-tree', id: 'clean-check' },
      undefined,
      createMockStepCtx(root),
    );
    expect(cleanCheckRes.ok).toBe(true);

    const rootHeadTree = (
      await runGitCommand({
        cwd: hostRepo.repoPath,
        args: ['rev-parse', `${root.headRef ?? root.baseRef}^{tree}`],
      })
    ).stdout.trim();
    await scope.release(child0);
    await scope.release(child1);
    await scope.release(root);

    const pinnedCompletedFork = (
      await runGitCommand({
        cwd: hostRepo.repoPath,
        args: ['rev-parse', 'refs/harness/completed/forks/run-fork-pin/call-1_branch_0'],
      })
    ).stdout.trim();
    expect(pinnedCompletedFork).toBe(receipt0.headRef);
    const pinnedCompletedRoot = (
      await runGitCommand({
        cwd: hostRepo.repoPath,
        args: ['rev-parse', 'refs/harness/completed/roots/run-fork-pin'],
      })
    ).stdout.trim();
    expect(pinnedCompletedRoot).toMatch(/^[0-9a-f]{40}$/);
    const pinnedCompletedRootTree = (
      await runGitCommand({
        cwd: hostRepo.repoPath,
        args: ['rev-parse', `${pinnedCompletedRoot}^{tree}`],
      })
    ).stdout.trim();
    expect(pinnedCompletedRootTree).toBe(rootHeadTree);
  }, 20_000);

  it('reconciles clean and conflicted commitChild via stateless merge-tree, populates unresolvedConflictPaths, and grants getConflictLease', async () => {
    const scopeNode = git
      .cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir })
      .toAST();
    const scope = new GitCowWorktreeScopeDriver(scopeNode);
    const parent = await scope.acquireRoot('run-conflict-merge');
    expect(scope.getConflictLease(parent)).toBeUndefined();

    const childA = await scope.forkChild(parent, 'worker-a');
    const childB = await scope.forkChild(parent, 'worker-b');

    await writeFile(
      path.join(childA.worktreePath, 'src/index.ts'),
      'export function add(a: number, b: number): number {\n  return a + b + 1;\n}\n',
      'utf8',
    );
    await writeFile(
      path.join(childB.worktreePath, 'src/index.ts'),
      'export function add(a: number, b: number): number {\n  return a + b + 99;\n}\n',
      'utf8',
    );

    const resA = await scope.commitChild(childA, parent);
    expect(resA.status).toBe('clean');
    expect(await readFile(path.join(parent.worktreePath, 'src/index.ts'), 'utf8')).toContain(
      'a + b + 1',
    );

    const parentHeadAfterA = parent.headRef;
    const resB = await scope.commitChild(childB, parent);
    expect(resB.status).toBe('conflict');
    expect(parent.headRef).toBe(parentHeadAfterA);
    expect(await readFile(path.join(parent.worktreePath, 'src/index.ts'), 'utf8')).toContain(
      'a + b + 1',
    );
    expect(Object.keys(childB.unresolvedConflictPaths)).toEqual(['src/index.ts']);
    expect(childB.baseRef).toBe(parentHeadAfterA);

    const lease = scope.getConflictLease(childB);
    expect(lease?.type).toBe('harness:lease-delta');
    expect(lease?.grantedMatchers).toEqual([
      {
        type: 'fs:match-globs',
        id: 'git-conflict-globs:worker-b',
        globs: ['src/index.ts'],
        mode: 'write',
      },
    ]);

    const conflictedCheck = await executeGitCleanWorkingTreeCheck(
      { type: 'git:clean-working-tree', id: 'clean-check' },
      undefined,
      createMockStepCtx(childB),
    );
    expect(conflictedCheck.ok).toBe(false);
    expect(conflictedCheck.deficits[0]).toContain('src/index.ts');

    const retryConflict = await scope.commitChild(childB, parent);
    expect(retryConflict.status).toBe('conflict');

    await writeFile(
      path.join(childB.worktreePath, 'src/index.ts'),
      'export function add(a: number, b: number): number {\n  return a + b + 100;\n}\n',
      'utf8',
    );
    const resolvedCheck = await executeGitCleanWorkingTreeCheck(
      { type: 'git:clean-working-tree', id: 'clean-check' },
      undefined,
      createMockStepCtx(childB),
    );
    expect(resolvedCheck.ok).toBe(true);
    expect(scope.getConflictLease(childB)).toBeUndefined();

    const resBResolved = await scope.commitChild(childB, parent);
    expect(resBResolved.status).toBe('clean');
    expect(await readFile(path.join(parent.worktreePath, 'src/index.ts'), 'utf8')).toContain(
      'a + b + 100',
    );

    const c1Content = await readFile(path.join(parent.worktreePath, 'src/index.ts'), 'utf8');
    await writeFile(
      path.join(parent.worktreePath, 'src/index.ts'),
      '<<<<<<< HEAD\nreturn a + b + 100;\n=======\nreturn a + b + 200;\n>>>>>>> prereq\n',
      'utf8',
    );
    const parentMeta = await readHarnessMeta(parent.gitDirPath);
    const simulatedConflicts = Object.freeze({ 'src/index.ts': '100644:simulated' });
    await writeHarnessMeta(parent.gitDirPath, {
      ...parentMeta,
      unresolvedConflictPaths: simulatedConflicts,
    });
    Object.assign(parent, { unresolvedConflictPaths: simulatedConflicts });

    const childC = await scope.forkChild(parent, 'worker-c');
    expect(Object.keys(childC.unresolvedConflictPaths)).toEqual(['src/index.ts']);
    await writeFile(path.join(childC.worktreePath, 'src/index.ts'), c1Content, 'utf8');

    const resC = await scope.commitChild(childC, parent);
    expect(resC.status).toBe('clean');
    expect(parent.unresolvedConflictPaths).toEqual({});
    expect((await readHarnessMeta(parent.gitDirPath)).unresolvedConflictPaths).toEqual({});
    expect(await readFile(path.join(parent.worktreePath, 'src/index.ts'), 'utf8')).toBe(c1Content);

    await scope.release(childA);
    await scope.release(childB);
    await scope.release(childC);
    await scope.release(parent);
  }, 20_000);

  it('executes syncChild, syncRoot stacked prerequisite lineage, and reattachRoot/reattachChild crash recovery', async () => {
    const scopeNode = git
      .cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir })
      .excludeFromCloneGlobs(['**/node_modules/excluded-cache/**'])
      .toAST();
    const scope = new GitCowWorktreeScopeDriver(scopeNode);

    const prereqRoot = await scope.acquireRoot('run-prereq');
    await writeFile(
      path.join(prereqRoot.worktreePath, 'src/prereq.ts'),
      'export const PREREQ = "v1";\n',
      'utf8',
    );
    const prereqReceipt = {
      ...(await scope.inspect(prereqRoot)),
      branchName: 'feat/prereq-1',
    };

    const downstreamRoot = await scope.acquireRoot('run-downstream');
    await mkdir(path.join(downstreamRoot.worktreePath, 'node_modules/excluded-cache'), { recursive: true });
    await writeFile(path.join(downstreamRoot.worktreePath, 'node_modules/excluded-cache/tmp.js'), 'cached\n', 'utf8');
    await mkdir(path.join(downstreamRoot.worktreePath, 'node_modules/kept-pkg'), { recursive: true });
    await writeFile(path.join(downstreamRoot.worktreePath, 'node_modules/kept-pkg/index.js'), 'kept\n', 'utf8');
    const pausedChild = await scope.forkChild(downstreamRoot, 'child-sync');
    await writeFile(
      path.join(pausedChild.worktreePath, 'src/child-local.ts'),
      'export const LOCAL = 42;\n',
      'utf8',
    );

    const syncRootRes = await scope.syncRoot(downstreamRoot, [prereqReceipt]);
    expect(syncRootRes.status).toBe('clean');
    expect(syncRootRes.data.rebasedOntoRef).toBe(prereqReceipt.headRef);
    expect(downstreamRoot.baseBranch).toBe('feat/prereq-1');
    expect(await readFile(path.join(downstreamRoot.worktreePath, 'src/prereq.ts'), 'utf8')).toContain(
      'PREREQ = "v1"',
    );

    const syncChildRes = await scope.syncChild(downstreamRoot, pausedChild);
    expect(syncChildRes.status).toBe('clean');
    expect(await readFile(path.join(pausedChild.worktreePath, 'src/prereq.ts'), 'utf8')).toContain(
      'PREREQ = "v1"',
    );
    expect(await readFile(path.join(pausedChild.worktreePath, 'src/child-local.ts'), 'utf8')).toContain(
      'LOCAL = 42',
    );

    const metaBeforeCrash = await readHarnessMeta(downstreamRoot.gitDirPath);
    await writeHarnessMeta(downstreamRoot.gitDirPath, {
      ...metaBeforeCrash,
      pendingParentHeadSha: prereqReceipt.headRef,
    });
    const reattachedRoot = await scope.reattachRoot('run-downstream');
    const metaAfterReattach = await readHarnessMeta(reattachedRoot.gitDirPath);
    expect(metaAfterReattach.pendingParentHeadSha).toBeUndefined();
    expect(reattachedRoot.headRef).toBe(prereqReceipt.headRef);

    const childCkpt = await scope.serializeCheckpoint(pausedChild);
    const reattachedChild = await scope.reattachChild(reattachedRoot, 'child-sync');
    expect(await readFile(path.join(reattachedChild.worktreePath, 'src/child-local.ts'), 'utf8')).toContain(
      'LOCAL = 42',
    );

    const conflictedContent = [
      '<<<<<<< HEAD',
      'export const LOCAL = 1;',
      '=======',
      'export const LOCAL = 42;',
      '>>>>>>> child',
      '',
    ].join('\n');
    await writeFile(
      path.join(pausedChild.worktreePath, 'src/child-local.ts'),
      conflictedContent,
      'utf8',
    );
    const conflictedReceipt = await scope.inspect(pausedChild);
    const mergedTreeSha = (
      await runGitCommand({
        cwd: pausedChild.worktreePath,
        args: ['rev-parse', `${conflictedReceipt.headRef}^{tree}`],
      })
    ).stdout.trim();
    await scope.restoreCheckpoint(pausedChild, childCkpt);

    const childMetaBeforeMergeCrash = await readHarnessMeta(pausedChild.gitDirPath);
    await writeHarnessMeta(pausedChild.gitDirPath, {
      ...childMetaBeforeMergeCrash,
      inFlightMerge: {
        targetHeadSha: prereqReceipt.headRef,
        mergedTreeSha,
        priorTreeSha: pausedChild.baseRef,
        unresolvedConflictPaths: { 'src/child-local.ts': 'PENDING' },
      },
    });
    const recoveredInFlightChild = await scope.reattachChild(reattachedRoot, 'child-sync');
    const childMetaAfterMergeCrash = await readHarnessMeta(recoveredInFlightChild.gitDirPath);
    expect(childMetaAfterMergeCrash.inFlightMerge).toBeUndefined();
    expect(recoveredInFlightChild.baseRef).toBe(prereqReceipt.headRef);
    expect(recoveredInFlightChild.headRef).toBe(prereqReceipt.headRef);
    expect(
      await readFile(path.join(recoveredInFlightChild.worktreePath, 'src/child-local.ts'), 'utf8'),
    ).toBe(conflictedContent);
    expect(recoveredInFlightChild.unresolvedConflictPaths['src/child-local.ts']).toMatch(
      /^100644:[0-9a-f]{64}$/,
    );

    await rm(pausedChild.worktreePath, { recursive: true, force: true });
    const recreatedChild = await scope.reattachChild(reattachedRoot, 'child-sync', childCkpt);
    expect(await readFile(path.join(recreatedChild.worktreePath, 'src/child-local.ts'), 'utf8')).toContain(
      'LOCAL = 42',
    );
    const excludedCloned = await lstat(
      path.join(recreatedChild.worktreePath, 'node_modules/excluded-cache/tmp.js'),
    ).then(
      () => true,
      () => false,
    );
    expect(excludedCloned).toBe(false);

    await scope.release(recreatedChild);
    await scope.release(prereqRoot);
    await scope.release(downstreamRoot);
  }, 20_000);

  it('extracts relative imports via es-module-lexer, computes git patch-id --stable across line shifts, and serializes writeHarnessMeta', async () => {
    const tsTestSource = [
      'import type { PublicContract } from "../src/index.js";',
      'import { add, type AddOpts } from "../src/index.js";',
      '/* import { secret } from "../src/internal/secret.js"; */',
      'const tpl = `from "../src/internal/secret.js"`;',
      'const sumValue: number = add(1, 2);',
    ].join('\n');
    const extracted = await extractRelativeImports(tsTestSource, 'test/unit.test.ts');
    expect(extracted).toEqual(['src/index.js', 'src/index.js']);

    const scopeNode = git.cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir }).toAST();
    const scope = new GitCowWorktreeScopeDriver(scopeNode);
    const rootA = await scope.acquireRoot('run-patch-shift-a');
    const rootB = await scope.acquireRoot('run-patch-shift-b');

    const origIndex = await readFile(path.join(rootB.worktreePath, 'src/index.ts'), 'utf8');
    await writeFile(path.join(rootB.worktreePath, 'src/index.ts'), `\n\n\n${origIndex}`, 'utf8');
    await runGitCommand({ cwd: rootB.worktreePath, args: ['add', 'src/index.ts'] });
    await runGitCommand({ cwd: rootB.worktreePath, args: ['commit', '-m', 'shift line numbers'] });
    const shiftedBaseSha = (await runGitCommand({ cwd: rootB.worktreePath, args: ['rev-parse', 'HEAD'] })).stdout.trim();
    Object.assign(rootB, { baseRef: shiftedBaseSha, headRef: shiftedBaseSha });

    await writeFile(path.join(rootA.worktreePath, 'src/index.ts'), `${origIndex}\nexport const EXTRA = 7;\n`, 'utf8');
    await writeFile(path.join(rootB.worktreePath, 'src/index.ts'), `\n\n\n${origIndex}\nexport const EXTRA = 7;\n`, 'utf8');
    const receiptA = await scope.inspect(rootA);
    const receiptB = await scope.inspect(rootB);

    const eqReports = await executeGitPatchEquivalence(
      git.patchEquivalence().toAST(),
      [
        { branchIndex: 0, scopeHandle: rootA, scopeReceipt: receiptA },
        { branchIndex: 1, scopeHandle: rootB, scopeReceipt: receiptB },
      ],
      createMockStepCtx(rootA),
    );
    const r0 = eqReports[0] as { readonly equivalenceGroupIndex: number; readonly equivalentBranchIndices: readonly number[]; readonly normalizedPatchDigest: string };
    const r1 = eqReports[1] as { readonly equivalenceGroupIndex: number; readonly equivalentBranchIndices: readonly number[]; readonly normalizedPatchDigest: string };
    expect(r0.normalizedPatchDigest).toBe(r1.normalizedPatchDigest);
    expect(r0.equivalenceGroupIndex).toBe(0);
    expect(r1.equivalenceGroupIndex).toBe(0);
    expect(r0.equivalentBranchIndices).toEqual([0, 1]);

    await Promise.all([
      writeHarnessMeta(rootA.gitDirPath, { baseRef: rootA.baseRef, baseBranch: 'main', branchName: 'b1', unresolvedConflictPaths: {} }),
      writeHarnessMeta(rootA.gitDirPath, { baseRef: rootA.baseRef, baseBranch: 'main', branchName: 'b2', unresolvedConflictPaths: {} }),
    ]);
    const finalMeta = await readHarnessMeta(rootA.gitDirPath);
    expect(['b1', 'b2']).toContain(finalMeta.branchName);

    await scope.release(rootA);
    await scope.release(rootB);
  }, 20_000);

  it('defaults repo to "." and dir to ".paraharness/worktree" on git.cowWorktree(options?) (P13)', () => {
    const explicit = git.cowWorktree({ repo: '.', dir: '.paraharness/worktree' });
    const zeroArg = git.cowWorktree();
    const onlyDir = git.cowWorktree({ dir: '/custom/worktrees' });
    const onlyRepo = git.cowWorktree({ repo: '/custom/repo' });

    expect(zeroArg.toAST()).toEqual(explicit.toAST());
    expect(onlyDir.toAST()).toEqual(
      git.cowWorktree({ repo: '.', dir: '/custom/worktrees' }).toAST(),
    );
    expect(onlyRepo.toAST()).toEqual(
      git.cowWorktree({ repo: '/custom/repo', dir: '.paraharness/worktree' }).toAST(),
    );
  });
});

