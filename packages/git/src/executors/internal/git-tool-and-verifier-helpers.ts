import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import type {
  CrossVerifierBranchCandidate,
  GitWorktreeHandle,
  StepExecutionContext,
} from '@harness-dsl/core';
import { init, parse } from 'es-module-lexer';
import {
  buildIsolatedWorktreeGitEnv,
  runGitCommand,
} from './git-cli-runner.js';
import {
  restoreGitWorktreeCheckpoint,
  serializeGitWorktreeCheckpoint,
} from './porcelain-v2-and-checkpoints.js';

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
  const diffRes = await runGitCommand({
    cwd,
    args: ['diff', '--name-only', '--diff-filter=AM', candidate.scopeHandle.baseRef, headSha],
    allowNonZeroExit: true,
  });
  const boundaryTests = new Map<string, string>();
  for (const rawLine of diffRes.stdout.split('\n')) {
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
 *
 * @returns {Promise<Record<string, unknown>>} Cross-test report for `target`.
 */
export async function runTransplantedTestsOnTarget(
  target: CrossVerifierBranchCandidate<GitWorktreeHandle>,
  testsToRun: ReadonlyMap<string, string>,
): Promise<Record<string, unknown>> {
  if (testsToRun.size === 0) {
    return { passedCrossTests: 0, failedCrossTests: 0, crossTestDeficits: [], transplantedTestFiles: [] };
  }
  const handle = target.scopeHandle;
  const ckpt = await serializeGitWorktreeCheckpoint(handle);
  let passedCrossTests = 0;
  let failedCrossTests = 0;
  const crossTestDeficits: string[] = [];
  const transplantedTestFiles: string[] = [];
  try {
    for (const [relPath, content] of testsToRun) {
      transplantedTestFiles.push(relPath);
      const absPath = path.join(handle.worktreePath, relPath);
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
      const nodeArgs = relPath.endsWith('.ts') ? ['--experimental-strip-types', absPath] : [absPath];
      const env = buildIsolatedWorktreeGitEnv(handle.worktreePath);
      const errMsg = await new Promise<string | undefined>((resolve) => {
        execFile(process.execPath, nodeArgs, { cwd: handle.worktreePath, env }, (err, stdout, stderr) => {
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
    await restoreGitWorktreeCheckpoint(handle, ckpt);
  }
  return { passedCrossTests, failedCrossTests, crossTestDeficits, transplantedTestFiles };
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
    : await serializeGitWorktreeCheckpoint(candidateHandle);
  try {
    const cwd = candidateHandle.worktreePath;
    const env = buildIsolatedWorktreeGitEnv(cwd);
    const bin = typeof command === 'string' ? 'sh' : (command[0] ?? 'true');
    const args = typeof command === 'string' ? ['-c', command] : command.slice(1);
    return await new Promise<Record<string, unknown>>((resolve) => {
      execFile(bin, args, { cwd, env }, (err, stdout, stderr) => {
        const exitCode = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
        resolve({ exitCode, stdout, stderr });
      });
    });
  } finally {
    if (scope !== undefined) await scope.restoreCheckpoint(candidateHandle, ckpt);
    else await restoreGitWorktreeCheckpoint(candidateHandle, ckpt);
  }
}
