import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { H, z, type BaseCheckASTNode, type FsPartitionMapNode, type GitWorktreeHandle, type NodeRunnerNode, type StepExecutionContext } from '@harness-dsl/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GitCowWorktreeScopeDriver, createGitCandidateComparisonToolDrivers, createGitRefReaderToolDrivers,
  executeGitCommitAndPushStep, executeGitDiscardBranchHook, executeGitKeepWorktreeHook,
  executeGitMergeQueueStep, executeGitPatchEquivalence, executeGitPublicSurfaceCrossTester,
  executeGitSnapshotAndResetHook, git, gitExecutors,
} from '../src/index.js';
import { readHarnessMeta, writeHarnessMeta } from '../src/executors/internal/git-cli-runner.js';
import { createTempGitHostRepo } from './fixtures/temp-git-host-repo.js';
import type { TempGitHostRepoHandle } from './fixtures/temp-git-host-repo-handle.js';

const TEST_RUNNER: NodeRunnerNode = Object.freeze({ type: 'node:runner', id: 'test-runner', slots: 2, maxDaemons: 1 });

function buildStepCtx(
  handle: GitWorktreeHandle,
  scope?: GitCowWorktreeScopeDriver,
  candidateHandles?: ReadonlyMap<number, GitWorktreeHandle>,
): StepExecutionContext<GitWorktreeHandle> {
  return {
    runId: 'run-hooks-tools',
    stepExecId: 'step-exec-1',
    scopeHandle: handle,
    scope: scope as never,
    candidateHandles,
    activePartitions: [],
    activeLeases: [],
    observedEffects: [],
    resolveEnv: (v) => (typeof v === 'string' ? v : 'resolved-secret'),
    getRunner: () => ({ id: 'test-runner', withSlot: (fn) => fn(), withDaemonSlot: (fn) => fn(() => undefined) }),
    recordEffects: () => undefined,
    registry: {
      steps: gitExecutors.steps ?? {}, sources: {}, checks: gitExecutors.checks ?? {},
      abortHooks: gitExecutors.abortHooks ?? {}, rewindHooks: gitExecutors.rewindHooks ?? {},
      crossVerifiers: gitExecutors.crossVerifiers ?? {}, services: {}, policyGuards: {},
      quotaTripwires: {}, telemetryCollectors: {}, effectMatchers: {}, tools: gitExecutors.tools ?? {},
      runners: {}, scopes: gitExecutors.scopes ?? {}, models: {}, ledgers: {},
      topologies: {}, lessons: {}, trackers: {}, streamSources: {}, humanChannels: {}, controlPlanes: {},
    },
  };
}

describe('git hooks, refReader/candidateComparison tools, cross-verifiers, commitAndPush, and mergeQueue', () => {
  let hostRepo: TempGitHostRepoHandle;

  beforeAll(async () => {
    hostRepo = await createTempGitHostRepo();
  });

  afterAll(async () => {
    await hostRepo.cleanup();
  });

  it('executes snapshotAndReset idempotently, keepWorktree, resetWorktree/discardBranch, and refReaderTools', async () => {
    const scopeNode = git
      .cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir })
      .toAST();
    const scope = new GitCowWorktreeScopeDriver(scopeNode);
    const handle = await scope.acquireRoot('run-abort-rewind');
    const ctx = buildStepCtx(handle, scope);

    const baseCkpt = await scope.serializeCheckpoint(handle);
    await writeFile(
      path.join(handle.worktreePath, 'src/aborted-work.ts'),
      'export const DRAFT = "saved-before-reset";\n',
      'utf8',
    );

    const abortNode = git.snapshotAndReset().toAST();
    const abortMeta1 = await executeGitSnapshotAndResetHook(
      abortNode,
      { handle, runId: 'run-abort-rewind', stepExecId: 'step-99' },
      ctx,
    );
    expect(abortMeta1.abortedSnapshotRef).toBe('refs/harness/aborted/run-abort-rewind/step-99');
    expect(abortMeta1.resetToRef).toBe(handle.baseRef);

    const abortMeta2 = await executeGitSnapshotAndResetHook(
      abortNode,
      { handle, runId: 'run-abort-rewind', stepExecId: 'step-99' },
      ctx,
    );
    expect(abortMeta2.abortedSnapshotRef).toBe(abortMeta1.abortedSnapshotRef);

    const [readRefTool, diffRefsTool, listRefFilesTool] = git.refReaderTools(TEST_RUNNER);
    const refDriver = createGitRefReaderToolDrivers();
    if (readRefTool === undefined || diffRefsTool === undefined || listRefFilesTool === undefined) {
      throw new Error('Expected 3 refReaderTools');
    }
    expect(refDriver.describeEffects?.(readRefTool, {}, handle)).toEqual([]);

    const readRes = await refDriver.execute(
      readRefTool,
      { ref: abortMeta1.abortedSnapshotRef, path: 'src/aborted-work.ts' },
      ctx,
    );
    expect(readRes.content).toContain('saved-before-reset');

    const diffRes = await refDriver.execute(
      diffRefsTool,
      { fromRef: handle.baseRef, toRef: abortMeta1.abortedSnapshotRef },
      ctx,
    );
    expect(diffRes.content).toContain('src/aborted-work.ts');

    const listRes = await refDriver.execute(
      listRefFilesTool,
      { ref: abortMeta1.abortedSnapshotRef, prefix: 'src/' },
      ctx,
    );
    expect(listRes.content).toContain('src/aborted-work.ts');
    expect(listRes.content).not.toContain('README.md');

    await writeFile(path.join(handle.worktreePath, 'src/keep.ts'), 'export const k = 1;\n', 'utf8');
    await executeGitKeepWorktreeHook(git.keepWorktree().toAST(), { handle }, ctx);
    expect(await readFile(path.join(handle.worktreePath, 'src/keep.ts'), 'utf8')).toBe(
      'export const k = 1;\n',
    );

    expect(git.resetWorktree().toAST().resetsRunOverlay).toBe(true);
    expect(git.discardBranch().toAST().resetsRunOverlay).toBe(true);
    await executeGitDiscardBranchHook(
      git.resetWorktree().toAST(),
      { handle, targetStepBaseScopeCheckpoint: baseCkpt },
      ctx,
    );
    const keepAfterDiscard = await readFile(
      path.join(handle.worktreePath, 'src/keep.ts'),
      'utf8',
    ).catch(() => 'ABSENT');
    expect(keepAfterDiscard).toBe('ABSENT');

    await scope.release(handle);
  }, 20_000);

  it('executes candidateComparisonTools (sandboxed evalInCandidates), publicSurfaceCrossTester, and patchEquivalence', async () => {
    const scopeNode = git
      .cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir })
      .toAST();
    const scope = new GitCowWorktreeScopeDriver(scopeNode);
    const root = await scope.acquireRoot('run-hooks-tools');
    const cand0 = await scope.forkChild(root, 'spec:branch:0');
    const cand1 = await scope.forkChild(root, 'spec:branch:1');

    await writeFile(
      path.join(cand0.worktreePath, 'src/index.mjs'),
      'export function multiply(a, b) { return a * b; }\n',
      'utf8',
    );
    await mkdir(path.join(cand0.worktreePath, 'test'), { recursive: true });
    await writeFile(
      path.join(cand0.worktreePath, 'test/public.test.mjs'),
      'import assert from "node:assert";\nimport { multiply } from "../src/index.mjs";\nassert.strictEqual(multiply(3, 4), 12);\n',
      'utf8',
    );
    await writeFile(
      path.join(cand1.worktreePath, 'src/index.mjs'),
      'export function multiply(a, b) { return a * b; }\n',
      'utf8',
    );

    const receipt0 = await scope.inspect(cand0);
    const receipt1 = await scope.inspect(cand1);

    const candMap = new Map<number, GitWorktreeHandle>([
      [0, cand0],
      [1, cand1],
    ]);
    const ctx = buildStepCtx(root, scope, candMap);
    const [diffCandTool, readCandTool, evalCandTool] = git.candidateComparisonTools(TEST_RUNNER);
    const compDriver = createGitCandidateComparisonToolDrivers();
    if (diffCandTool === undefined || readCandTool === undefined || evalCandTool === undefined) {
      throw new Error('Expected 3 candidateComparisonTools');
    }

    const diffCandRes = await compDriver.execute(diffCandTool, { fromBranchIndex: 0, toBranchIndex: 1 }, ctx);
    expect(diffCandRes.content).toContain('test/public.test.mjs');
    const readCandRes = await compDriver.execute(readCandTool, { branchIndex: 0, path: 'test/public.test.mjs' }, ctx);
    expect(readCandRes.content).toContain('multiply(3, 4)');

    const evalRes = await compDriver.execute(
      evalCandTool,
      { branchIndices: [0, 1], command: 'echo "mutated" > polluted.txt && cat polluted.txt' },
      ctx,
    );
    const parsedEval = JSON.parse(evalRes.content) as Array<{
      readonly branchIndex: number;
      readonly exitCode: number;
      readonly stdout: string;
    }>;
    expect(parsedEval).toHaveLength(2);
    expect(parsedEval[0]?.exitCode).toBe(0);
    const pollutedRemains = await readFile(path.join(cand0.worktreePath, 'polluted.txt'), 'utf8').catch(() => 'CLEAN');
    expect(pollutedRemains).toBe('CLEAN');

    const evalSingleRes = await compDriver.execute(
      evalCandTool,
      { branchIndex: 1, argv: [process.execPath, '-e', 'process.stdout.write("argv-ok")'] },
      ctx,
    );
    const parsedSingle = JSON.parse(evalSingleRes.content) as Array<{
      readonly branchIndex: number;
      readonly exitCode: number;
      readonly stdout: string;
    }>;
    expect(parsedSingle).toEqual([{ branchIndex: 1, exitCode: 0, stdout: 'argv-ok', stderr: '' }]);

    const partitionMap = Object.freeze<FsPartitionMapNode<'core'>>({
      type: 'fs:partition-map',
      topology: {
        type: 'harness:topology',
        id: 'repo-topology',
        store: { type: 'sqlite:topology' },
        partitions: { core: { dependsOn: [] } },
        commitOverlayWhen: undefined,
      },
      mapping: {
        core: { globs: ['src/**'], boundaryGlobs: ['src/index.mjs', 'src/index.ts'] },
      },
    });

    const crossTesterBuilder = git.publicSurfaceCrossTester({
      runner: TEST_RUNNER,
      partitionMap,
    });
    expect(crossTesterBuilder.id).toBe('git-public-surface-cross-tester');
    const sampleReport = {
      branchIndex: 0,
      passedCrossTests: 1,
      failedCrossTests: 0,
      crossTestDeficits: [],
      transplantedTestFiles: [],
      failureLog: '',
    };
    expect(crossTesterBuilder.reportSchema.parse(sampleReport)).toEqual(sampleReport);
    const crossReports = await executeGitPublicSurfaceCrossTester(
      crossTesterBuilder.toAST(),
      [
        { branchIndex: 0, scopeHandle: cand0, scopeReceipt: receipt0 },
        { branchIndex: 1, scopeHandle: cand1, scopeReceipt: receipt1 },
      ],
      ctx,
    );
    expect((crossReports[1] as { readonly passedCrossTests: number }).passedCrossTests).toBe(1);

    const patchEqBuilder = git.patchEquivalence();
    expect(patchEqBuilder.id).toBe('git-patch-equivalence');
    const eqReports = await executeGitPatchEquivalence(
      patchEqBuilder.toAST(),
      [
        { branchIndex: 0, scopeHandle: cand0, scopeReceipt: receipt0 },
        { branchIndex: 1, scopeHandle: cand1, scopeReceipt: receipt1 },
      ],
      ctx,
    );
    expect(
      (eqReports[0] as { readonly equivalenceGroupIndex: number }).equivalenceGroupIndex,
    ).toBe(0);
    expect(
      (eqReports[1] as { readonly equivalenceGroupIndex: number }).equivalenceGroupIndex,
    ).toBe(1);

    await scope.release(cand0);
    await scope.release(cand1);
    await scope.release(root);
  }, 20_000);

  it('executes commitAndPush (rolling back to preStepHeadSha on failure) and mergeQueue cumulative bisection', async () => {
    const scopeNode = git
      .cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir })
      .toAST();
    const scope = new GitCowWorktreeScopeDriver(scopeNode);
    const root = await scope.acquireRoot('run-commit-push');

    await writeFile(
      path.join(root.worktreePath, 'src/feature.ts'),
      'export const FEATURE = "ready";\n',
      'utf8',
    );

    const failVerifyCheck: BaseCheckASTNode<'local:command-check', GitWorktreeHandle> & {
      readonly command: string;
    } = {
      type: 'local:command-check',
      id: 'fail-verify',
      command: 'exit 1',
    };
    const failingScopeNode = git
      .cowWorktree({ repo: hostRepo.repoPath, dir: hostRepo.worktreesDir })
      .reconcileStrategy('rebase-onto-base', {
        verifyWith: failVerifyCheck,
      })
      .toAST();

    const commitPushNode = git
      .commitAndPush('push-feature', {
        branch: (inp: { readonly branch: string }) => inp.branch,
        message: () => 'feat: add feature',
      })
      .input(z.object({ branch: z.string() }))
      .runner(TEST_RUNNER)
      .env({ CUSTOM_VAR: H.env('SECRET_TOKEN') })
      .toAST();

    const failCtx: StepExecutionContext<GitWorktreeHandle> = {
      ...buildStepCtx(root, scope),
      scopeNode: failingScopeNode,
    };
    const origBaseRef = root.baseRef;
    await expect(
      executeGitCommitAndPushStep(commitPushNode, { branch: 'feat/rolled-back' }, failCtx),
    ).rejects.toThrow(/fail-verify/);

    const metaAfterFail = await readHarnessMeta(root.gitDirPath);
    expect(metaAfterFail.inFlightCommitAndPush).toBeUndefined();
    expect(root.baseRef).toBe(origBaseRef);
    expect(await readFile(path.join(root.worktreePath, 'src/feature.ts'), 'utf8')).toContain(
      'FEATURE = "ready"',
    );

    const passCtx: StepExecutionContext<GitWorktreeHandle> = {
      ...buildStepCtx(root, scope),
      scopeNode,
    };
    await executeGitCommitAndPushStep(commitPushNode, { branch: 'feat/landed-1' }, passCtx);
    expect(root.branchName).toBe('feat/landed-1');

    const makeCandidateCommit = async (fileRel: string, content: string): Promise<string> => {
      const wt = await scope.acquireRoot(`cand-${path.basename(fileRel, '.ts')}`);
      await writeFile(path.join(wt.worktreePath, fileRel), content, 'utf8');
      const r = await scope.inspect(wt);
      await scope.release(wt);
      return r.headRef;
    };

    const shaGood1 = await makeCandidateCommit('src/m1.ts', 'export const m1 = 1;\n');
    const shaBad2 = await makeCandidateCommit('src/bad.ts', 'BROKEN_MARKER\n');
    const shaGood3 = await makeCandidateCommit('src/m3.ts', 'export const m3 = 3;\n');

    const mqWorktree = await scope.acquireRoot('run-merge-queue');
    const checkNoBroken: BaseCheckASTNode<'local:command-check', GitWorktreeHandle> & {
      readonly command: string;
    } = {
      type: 'local:command-check',
      id: 'check-no-broken',
      command: 'test ! -f src/bad.ts',
    };
    const mqNode = git
      .mergeQueue('land-train', {
        targetBranch: 'main',
        maxBatchSize: 3,
        verifyWith: checkNoBroken,
      })
      .toAST();

    const mqResult = (await executeGitMergeQueueStep(
      mqNode,
      {
        candidates: [
          { branchName: 'feat/m1', headRef: shaGood1, baseRef: hostRepo.initialCommitSha },
          { branchName: 'feat/bad2', headRef: shaBad2, baseRef: hostRepo.initialCommitSha },
          { branchName: 'feat/m3', headRef: shaGood3, baseRef: hostRepo.initialCommitSha },
        ],
      },
      buildStepCtx(mqWorktree, scope),
    )) as {
      readonly landedBranches: readonly string[];
      readonly evictedBranches: readonly string[];
    };

    expect(mqResult.landedBranches).toEqual(['feat/m1', 'feat/m3']);
    expect(mqResult.evictedBranches).toEqual(['feat/bad2']);

    await writeHarnessMeta(mqWorktree.gitDirPath, {
      baseRef: hostRepo.initialCommitSha,
      baseBranch: 'main',
      unresolvedConflictPaths: {},
      inFlightCommitAndPush: {
        preStepHeadSha: shaGood1,
        preStepBaseRef: hostRepo.initialCommitSha,
        targetBranch: 'feat/interrupted',
      },
    });
    const recoveredMq = await scope.reattachRoot('run-merge-queue');
    expect(recoveredMq.headRef).toBe(shaGood1);
    expect((await readHarnessMeta(recoveredMq.gitDirPath)).inFlightCommitAndPush).toBeUndefined();

    await scope.release(mqWorktree);
    await scope.release(root);
  }, 20_000);
});
