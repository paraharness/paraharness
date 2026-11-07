import { type ExecFileException, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import type {
  CrossVerifierBranchCandidate,
  GitPublicSurfaceCrossTesterNode,
  GitWorktreeHandle,
  StepExecutionContext,
} from '@harness-dsl/core';
import { init, parse } from 'es-module-lexer';
import picomatch from 'picomatch';
import { gitCheckpointRestore } from './git-checkpoint-restore.js';
import { gitCheckpointSerialize } from './git-checkpoint-serialize.js';
import {
  buildIsolatedWorktreeGitEnv,
  runGitCommand,
} from './git-cli-runner.js';

/**
 * Extracts and normalizes relative module import paths from a test file's source text using `es-module-lexer`.
 *
 * Resolves `./` and `../` specifiers relative to `testFileRelPath` while ignoring fake imports in comments or string literals.
 *
 * @param {string} sourceCode      - Raw UTF-8 test file contents.
 * @param {string} testFileRelPath - Posix-normalized repository-relative path of the test file.
 *
 * @returns {Promise<readonly string[]>} Normalized repository-relative imported file paths.
 */
export async function extractRelativeImports(
  sourceCode: string,
  testFileRelPath: string,
): Promise<readonly string[]> {
  await init();
  let imports: ReturnType<typeof parse>[0];
  try {
    [imports] = parse(sourceCode, testFileRelPath);
  } catch {
    const stripped = stripTypeScriptTypes(sourceCode, { mode: 'strip' });
    [imports] = parse(stripped, testFileRelPath);
  }
  const dir = path.posix.dirname(testFileRelPath);
  const resolvedPaths: string[] = [];
  for (const imp of imports) {
    const specifier = imp.specifier;
    if (typeof specifier === 'string' && specifier.startsWith('.')) {
      resolvedPaths.push(path.posix.normalize(path.posix.join(dir, specifier)));
    }
  }
  return Object.freeze(resolvedPaths);
}

/**
 * Pre-compiles all boundary glob patterns from `node.partitionMap` into a single predicate function.
 *
 * @param {GitPublicSurfaceCrossTesterNode<unknown>} node - Public-surface cross-tester AST node.
 *
 * @returns {(candidatePath: string) => boolean} Predicate returning `true` when `candidatePath` matches a public boundary glob.
 */
export function compileBoundaryGlobMatcher(
  node: GitPublicSurfaceCrossTesterNode<unknown>,
): (candidatePath: string) => boolean {
  const matchers: Array<(candidatePath: string) => boolean> = [];
  for (const part of Object.values(node.partitionMap.mapping)) {
    for (const glob of part.boundaryGlobs) matchers.push(picomatch(glob, { dot: true }));
  }
  return (candidatePath: string): boolean => {
    for (const isMatch of matchers) {
      if (isMatch(candidatePath)) return true;
    }
    return false;
  };
}

/**
 * Collects newly added or modified test files in `candidate` that import exclusively from `isBoundaryPath`.
 *
 * Inspects `git diff --name-only <baseRef> <headRef>` for test files and verifies their relative imports.
 *
 * @param {CrossVerifierBranchCandidate<GitWorktreeHandle>} candidate      - Speculative candidate descriptor.
 * @param {(candidatePath: string) => boolean}              isBoundaryPath - Compiled boundary glob matcher.
 *
 * @returns {Promise<ReadonlyMap<string, string>>} Map of boundary-only test relative paths to their file contents.
 */
export async function collectCandidateBoundaryTests(
  candidate: CrossVerifierBranchCandidate<GitWorktreeHandle>,
  isBoundaryPath: (candidatePath: string) => boolean,
): Promise<ReadonlyMap<string, string>> {
  const cwd = candidate.scopeHandle.worktreePath;
  const headSha = typeof candidate.scopeReceipt['headRef'] === 'string'
    ? candidate.scopeReceipt['headRef']
    : (candidate.scopeHandle.headRef ?? candidate.scopeHandle.baseRef);
  const diffOutput = await runGitCommand({
    cwd,
    args: ['diff', '--name-only', '--diff-filter=AM', candidate.scopeHandle.baseRef, headSha],
    allowNonZeroExit: true,
  });
  const boundaryTests = new Map<string, string>();
  for (const rawLine of diffOutput.stdout.split('\n')) {
    const relPath = rawLine.trim();
    if (relPath.length === 0 || !/(?:\.test\.|\.spec\.|^test\/|\/test\/)/.test(relPath)) continue;
    const content = await readFile(path.join(cwd, relPath), 'utf8').catch(() => undefined);
    if (content === undefined) continue;
    const imports = await extractRelativeImports(content, relPath);
    const allBoundary = imports.length > 0 && imports.every((imp) =>
      isBoundaryPath(imp) || isBoundaryPath(imp.replace(/\.js$/, '.ts')) || isBoundaryPath(`${imp}/index.ts`));
    if (allBoundary) boundaryTests.set(relPath, content);
  }
  return boundaryTests;
}

/**
 * Transplants `testsToRun` into `target` inside a checkpoint sandbox and executes each test file.
 *
 * Restores `target.scopeHandle` to its pre-test checkpoint in a `finally` block.
 *
 * @param {CrossVerifierBranchCandidate<GitWorktreeHandle>} target     - Target candidate branch receiving tests.
 * @param {ReadonlyMap<string, string>}                     testsToRun - Boundary test files mapped to source content.
 * @param {AbortSignal}                                     [signal]   - Optional cancellation signal forwarded to child processes.
 *
 * @returns {Promise<Record<string, unknown>>} Cross-test report for `target`.
 */
export async function runTransplantedTestsOnTarget(
  target: CrossVerifierBranchCandidate<GitWorktreeHandle>,
  testsToRun: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (testsToRun.size === 0) {
    return { passedCrossTests: 0, failedCrossTests: 0, crossTestDeficits: [], transplantedTestFiles: [] };
  }
  const handle = target.scopeHandle;
  const ckpt = await gitCheckpointSerialize(handle);
  let passedCrossTests = 0;
  let failedCrossTests = 0;
  const crossTestDeficits: string[] = [];
  const transplantedTestFiles: string[] = [];
  try {
    for (const [relPath, content] of testsToRun) {
      signal?.throwIfAborted();
      transplantedTestFiles.push(relPath);
      const absPath = path.join(handle.worktreePath, relPath);
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
      const nodeArgs = relPath.endsWith('.ts') ? ['--experimental-strip-types', absPath] : [absPath];
      const env = buildIsolatedWorktreeGitEnv(handle.worktreePath);
      const errMsg = await new Promise<string | undefined>((resolve) => {
        execFile(process.execPath, nodeArgs, { cwd: handle.worktreePath, env, signal }, (err, stdout, stderr) => {
          resolve(err === null ? undefined : (stderr || stdout || err.message).trim());
        });
      });
      if (errMsg === undefined) passedCrossTests += 1;
      else {
        failedCrossTests += 1;
        crossTestDeficits.push(`${relPath}: ${errMsg}`);
      }
    }
  } finally {
    await gitCheckpointRestore(handle, ckpt);
  }
  return { passedCrossTests, failedCrossTests, crossTestDeficits, transplantedTestFiles };
}

/**
 * Executes cross-verification of public-surface tests across all speculative `candidates`.
 *
 * Collects boundary-only tests from each candidate and transplants them into every sibling candidate.
 *
 * @param {GitPublicSurfaceCrossTesterNode<unknown>}                       node       - Public-surface cross-tester AST node.
 * @param {ReadonlyArray<CrossVerifierBranchCandidate<GitWorktreeHandle>>} candidates - Surviving speculative candidate branches.
 * @param {AbortSignal}                                                    [signal]   - Optional cancellation signal forwarded to child processes.
 *
 * @returns {Promise<Readonly<Record<number, unknown>>>} Validated per-branch cross-testing report indexed by `branchIndex`.
 */
export async function runPublicSurfaceCrossVerification(
  node: GitPublicSurfaceCrossTesterNode<unknown>,
  candidates: ReadonlyArray<CrossVerifierBranchCandidate<GitWorktreeHandle>>,
  signal?: AbortSignal,
): Promise<Readonly<Record<number, unknown>>> {
  const isBoundaryPath = compileBoundaryGlobMatcher(node);
  const testsByBranch = new Map<number, ReadonlyMap<string, string>>();
  for (const cand of candidates) {
    testsByBranch.set(cand.branchIndex, await collectCandidateBoundaryTests(cand, isBoundaryPath));
  }
  const reports: Record<number, unknown> = {};
  for (const target of candidates) {
    const mergedTests = new Map<string, string>();
    for (const [sourceIdx, testMap] of testsByBranch) {
      if (sourceIdx === target.branchIndex) continue;
      for (const [relPath, content] of testMap) mergedTests.set(relPath, content);
    }
    const rawReport = await runTransplantedTestsOnTarget(target, mergedTests, signal);
    reports[target.branchIndex] = node.reportSchema.parse(rawReport);
  }
  return Object.freeze(reports);
}

/**
 * Resolves a numeric process exit code from an `execFile` error callback argument.
 *
 * @param {ExecFileException | null} execError - Error object from `execFile`, or `null` on exit `0`.
 *
 * @returns {number} Numeric exit code (`0` on success, `execError.code` when numeric, or `1`).
 */
function resolveExecFileExitCode(
  execError: ExecFileException | null,
): number {
  if (execError === null) return 0;
  if (typeof execError.code === 'number') return execError.code;
  return 1;
}

/**
 * Runs an arbitrary benchmark or evaluation command inside `candidateHandle` wrapped in a checkpoint rollback.
 *
 * Guarantees `candidateHandle` remains bit-for-bit identical after `command` finishes.
 *
 * @param {GitWorktreeHandle}                       candidateHandle - Target candidate worktree handle.
 * @param {string | readonly string[]}              command         - Shell command string or argv tuple to execute.
 * @param {StepExecutionContext<GitWorktreeHandle>} ctx             - Active step execution context.
 *
 * @returns {Promise<Record<string, unknown>>} Command execution result `{ exitCode, stdout, stderr }`.
 */
export async function runEvalCommandInSandboxedCandidate(
  candidateHandle: GitWorktreeHandle,
  command: string | readonly string[],
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<Record<string, unknown>> {
  const scope = ctx.scope !== undefined && 'serializeCheckpoint' in ctx.scope && 'restoreCheckpoint' in ctx.scope
    ? ctx.scope
    : undefined;
  const ckpt = scope !== undefined
    ? await scope.serializeCheckpoint(candidateHandle)
    : await gitCheckpointSerialize(candidateHandle);
  try {
    const cwd = candidateHandle.worktreePath;
    const env = buildIsolatedWorktreeGitEnv(cwd);
    const bin = typeof command === 'string' ? 'sh' : (command[0] ?? 'true');
    const args = typeof command === 'string' ? ['-c', command] : command.slice(1);
    return await new Promise<Record<string, unknown>>((resolve) => {
      execFile(bin, args, { cwd, env, signal: ctx.signal }, (err, stdout, stderr) => {
        const exitCode = resolveExecFileExitCode(err);
        resolve({ exitCode, stdout, stderr });
      });
    });
  } finally {
    if (scope !== undefined) await scope.restoreCheckpoint(candidateHandle, ckpt);
    else await gitCheckpointRestore(candidateHandle, ckpt);
  }
}
