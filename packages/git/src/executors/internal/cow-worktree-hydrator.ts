import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import type { ASTNode, GitCowWorktreeNode } from '@harness-dsl/core';
import { withFileLock } from '@harness-dsl/lockfile';
import writeFileAtomic from 'write-file-atomic';
import {
  compileWorktreeExcludeMatcher,
  copyFileCowOrValue,
} from './file-digest-and-globs.js';
import { buildIsolatedWorktreeGitEnv, runGitCommand } from './git-cli-runner.js';

/**
 * Clones a single directory entry inside `node_modules` using symlink recreation, `.prisma` value copy, or hardlinking.
 *
 * @param {Dirent}   entry    - Directory entry read from `srcRoot`.
 * @param {string}   childRel - Repository-relative path of `entry`.
 * @param {string}   srcRoot  - Source repository or parent worktree root path.
 * @param {string}   destRoot - Destination worktree root path.
 * @param {string[]} stack    - DFS directory traversal stack to push subdirectories onto.
 *
 * @returns {Promise<void>} Resolves once the entry is cloned or pushed onto `stack`.
 */
async function cloneSingleNodeModulesEntry(
  entry: Dirent,
  childRel: string,
  srcRoot: string,
  destRoot: string,
  stack: string[],
): Promise<void> {
  if (entry.isDirectory()) {
    stack.push(childRel);
    return;
  }
  const srcAbs = path.join(srcRoot, childRel);
  const destAbs = path.join(destRoot, childRel);
  if (entry.isSymbolicLink()) {
    await mkdir(path.dirname(destAbs), { recursive: true });
    await rm(destAbs, { force: true });
    await symlink(await readlink(srcAbs, 'utf8'), destAbs);
    return;
  }
  if (childRel.includes('/.prisma/')) {
    await copyFileCowOrValue(srcAbs, destAbs);
    return;
  }
  await mkdir(path.dirname(destAbs), { recursive: true });
  await rm(destAbs, { force: true });
  await link(srcAbs, destAbs).catch(() => copyFileCowOrValue(srcAbs, destAbs));
}

/**
 * Recursively clones `srcNodeModules` into `destNodeModules` using hardlinks (`link`) for regular files and `symlink` for links.
 *
 * Copies `.prisma` directories by value and skips any paths matching `excludeGlobs`.
 *
 * @param {string}                        srcRoot        - Source repository or parent worktree path.
 * @param {string}                        destRoot       - Destination worktree path.
 * @param {readonly string[] | undefined} [excludeGlobs] - Optional glob patterns excluded from cloning.
 *
 * @returns {Promise<void>} Resolves once `node_modules` is cloned into `destRoot`.
 */
export async function cloneNodeModulesTree(
  srcRoot: string,
  destRoot: string,
  excludeGlobs?: readonly string[],
): Promise<void> {
  const srcNm = path.join(srcRoot, 'node_modules');
  const stat = await lstat(srcNm).catch(() => null);
  if (stat === null || !stat.isDirectory()) return;
  const isExcluded = compileWorktreeExcludeMatcher(excludeGlobs);
  const stack: string[] = ['node_modules'];
  while (stack.length > 0) {
    const relDir = stack.pop() ?? '';
    if (isExcluded(relDir)) continue;
    const entries = await readdir(path.join(srcRoot, relDir), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = `${relDir}/${entry.name}`;
      if (isExcluded(childRel)) continue;
      await cloneSingleNodeModulesEntry(entry, childRel, srcRoot, destRoot, stack);
    }
  }
}

/**
 * Evaluates `.lockfileGate(lockfilePath)` between `repoPath` and `worktreePath` and hydrates `node_modules` or runs `setupCommands`.
 *
 * On a lockfile hash hit, hardlinks `node_modules` and skips setup; on a miss, unlinks any hardlinked `node_modules` and runs `setupCommands`.
 *
 * @param {GitCowWorktreeNode} node         - Worktree scope AST node configuration.
 * @param {string}             repoPath     - Host repository root path.
 * @param {string}             worktreePath - Newly created root worktree path.
 *
 * @returns {Promise<void>} Resolves once `node_modules` hydration and any required setup commands complete.
 */
export async function hydrateWorktreeDependencies(
  node: GitCowWorktreeNode,
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  await cloneNodeModulesTree(repoPath, worktreePath, node.excludeFromCloneGlobs);
  if (node.lockfileGatePath !== undefined) {
    const isHit = await evaluateLockfileGateHit(repoPath, worktreePath, node.lockfileGatePath);
    if (isHit) return;
    await rm(path.join(worktreePath, 'node_modules'), { recursive: true, force: true });
  } else if (node.setupCommands.length > 0) {
    await rm(path.join(worktreePath, 'node_modules'), { recursive: true, force: true });
  }
  for (const cmdNode of node.setupCommands) {
    await executeSetupCommandNode(cmdNode, worktreePath);
  }
}

/**
 * Checks whether the lockfile at `lockfileGatePath` in `worktreePath` matches the host repository's warm `node_modules` cache hash.
 *
 * Records the initial host lockfile hash in `<hostGitDir>/harness-warm-lockfile.sha256` when `repoPath/node_modules` is first observed.
 *
 * @param {string} repoPath         - Host repository root path.
 * @param {string} worktreePath     - Target worktree path.
 * @param {string} lockfileGatePath - Repository-relative path to the lockfile (such as `'pnpm-lock.yaml'`).
 *
 * @returns {Promise<boolean>} `true` on a lockfile cache hit, or `false` on a gate miss.
 */
export async function evaluateLockfileGateHit(
  repoPath: string,
  worktreePath: string,
  lockfileGatePath: string,
): Promise<boolean> {
  const hostNmStat = await lstat(path.join(repoPath, 'node_modules')).catch(() => null);
  if (hostNmStat === null || !hostNmStat.isDirectory()) return false;
  const wtLockBuf = await readFile(path.join(worktreePath, lockfileGatePath)).catch(() => null);
  const hostLockBuf = await readFile(path.join(repoPath, lockfileGatePath)).catch(() => null);
  if (wtLockBuf === null || hostLockBuf === null) return false;
  const wtHash = createHash('sha256').update(wtLockBuf).digest('hex');
  const hostHash = createHash('sha256').update(hostLockBuf).digest('hex');
  const gitCommonOutput = await runGitCommand({ cwd: repoPath, args: ['rev-parse', '--git-common-dir'] });
  const commonGitDir = path.resolve(repoPath, gitCommonOutput.stdout.trim());
  const cacheFile = path.join(commonGitDir, 'harness-warm-lockfile.sha256');
  const lockPath = path.join(commonGitDir, 'harness-warm-lockfile.lock');
  return withFileLock(lockPath, async () => {
    const cachedHash = await readFile(cacheFile, 'utf8').catch(() => null);
    if (cachedHash === null) {
      await writeFileAtomic(cacheFile, hostHash, { encoding: 'utf8' });
      return wtHash === hostHash;
    }
    return wtHash === cachedHash.trim() && wtHash === hostHash;
  });
}

/**
 * Executes a single setup command AST node (`node:command` or `harness:command`) inside `worktreePath`.
 *
 * Spawns `argv` with the isolated worktree Git environment when `cmdNode` is a `LocalCommandNode`.
 *
 * @param {ASTNode} cmdNode      - Setup command AST node from `GitCowWorktreeNode.setupCommands`.
 * @param {string}  worktreePath - Target root worktree path.
 *
 * @returns {Promise<void>} Resolves once the setup command finishes with exit code `0`.
 *
 * @throws {Error} If the setup command exits with a non-zero status code.
 */
export async function executeSetupCommandNode(
  cmdNode: ASTNode,
  worktreePath: string,
): Promise<void> {
  if (!('argv' in cmdNode)) return;
  const rawArgv = typeof cmdNode.argv === 'function' ? (cmdNode.argv as (input: undefined) => readonly string[])(undefined) : cmdNode.argv;
  if (!Array.isArray(rawArgv) || rawArgv.length === 0) return;
  const argv = rawArgv.map(String);
  const bin = argv[0];
  if (bin === undefined) return;
  const env = buildIsolatedWorktreeGitEnv(worktreePath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, argv.slice(1), { cwd: worktreePath, env, stdio: 'pipe' });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
    });
    child.on('error', reject);
    child.on('close', (code: number | null) => {
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      if ((code ?? 1) !== 0) reject(new Error(`Worktree setup command '${argv.join(' ')}' failed (exit ${code ?? 1}): ${stderrText}`));
      else resolve();
    });
    child.stdin.end();
  });
}
