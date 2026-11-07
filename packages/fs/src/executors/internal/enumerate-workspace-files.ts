import { execFileSync } from 'node:child_process';
import {
  type Dirent,
  type PathLike,
  existsSync,
  readdir,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import type { ToolEffect } from '@harness-dsl/core';
import { type FileSystemAdapter, glob, globSync } from 'tinyglobby';
import {
  compileGlobOrExactMatcher,
  extractWorktreeRootAndBaseRef,
} from './jail-and-glob-helpers.js';

/**
 * Filters directory entries for `tinyglobby` so symlinks escaping `realRoot`, broken symlinks, and cycles are skipped.
 *
 * Enforces `realpathSync` containment inside `realRoot` and prevents cyclic directory symlink recursion.
 *
 * @param {string}            realRoot    - Canonicalized `realpathSync` root directory of the workspace.
 * @param {Set<string>}       visitedDirs - Set of canonical directory paths already visited in this walk.
 * @param {string}            dirPath     - Current directory path being read by `tinyglobby`.
 * @param {readonly Dirent[]} entries     - Raw directory entries returned by `fs.readdir`.
 *
 * @returns {Dirent[]} Filtered array of jailed directory entries.
 */
function filterJailedDirents(
  realRoot: string,
  visitedDirs: Set<string>,
  dirPath: string,
  entries: readonly Dirent[],
): Dirent[] {
  let realDir: string;
  try {
    realDir = realpathSync(dirPath);
  } catch {
    return [];
  }
  const dirRel = path.relative(realRoot, realDir);
  if (dirRel === '..' || dirRel.startsWith('../') || dirRel.startsWith(`..${path.sep}`) || path.isAbsolute(dirRel)) return [];
  const allowed: Dirent[] = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    let realTarget: string;
    try {
      realTarget = realpathSync(path.join(dirPath, entry.name));
    } catch {
      continue;
    }
    const rel = path.relative(realRoot, realTarget);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    if (entry.isSymbolicLink() && statSync(realTarget).isDirectory()) {
      if (visitedDirs.has(realTarget) || realDir === realTarget || realDir.startsWith(`${realTarget}${path.sep}`)) continue;
      visitedDirs.add(realTarget);
    }
    allowed.push(entry);
  }
  return allowed;
}

/**
 * Asynchronously enumerates all jailed workspace-relative POSIX file paths matching `globPattern` via `tinyglobby`.
 *
 * Uses `glob` from `tinyglobby` with `picomatch` verification, skipping `.git`, `node_modules`,
 * and any symlink target escaping `rootPath`.
 *
 * @param {string}                     rootPath    - Worktree or repository root directory path.
 * @param {string | readonly string[]} globPattern - POSIX glob pattern(s) to match against relative paths.
 *
 * @returns {Promise<readonly string[]>} Sorted frozen array of matching relative POSIX file paths.
 */
export async function enumerateWorkspaceFiles(
  rootPath: string,
  globPattern: string | readonly string[],
): Promise<readonly string[]> {
  const realRoot = realpathSync(path.resolve(rootPath));
  const visited = new Set<string>([realRoot]);
  const patternList = typeof globPattern === 'string' ? [globPattern] : globPattern;
  const isMatch = compileGlobOrExactMatcher(patternList);
  const rawMatches = await glob(patternList, {
    cwd: realRoot,
    dot: true,
    onlyFiles: true,
    ignore: ['**/.git/**', '**/node_modules/**'],
    fs: {
      readdir: ((dir: string, _opts: unknown, cb?: (err: NodeJS.ErrnoException | null, files: Dirent[]) => void) => {
        readdir(dir, { withFileTypes: true }, (err, list) => cb?.(err, err !== null ? [] : filterJailedDirents(realRoot, visited, String(dir), list)));
      }) as typeof readdir,
    },
  });
  const matched: string[] = [];
  for (const entry of rawMatches) {
    const cleanRel = entry.replace(/\\/g, '/').replace(/\/+$/, '');
    if (isMatch(cleanRel)) matched.push(cleanRel);
  }
  matched.sort((a, b) => a.localeCompare(b));
  return Object.freeze(matched);
}

/**
 * Synchronously enumerates all jailed workspace-relative POSIX file paths matching `globPattern` via `tinyglobby`.
 *
 * Uses `globSync` from `tinyglobby` with `picomatch` verification for synchronous `describeEffects` evaluation.
 *
 * @param {string}                     rootPath    - Worktree or repository root directory path.
 * @param {string | readonly string[]} globPattern - POSIX glob pattern(s) to match against relative paths.
 *
 * @returns {readonly string[]} Sorted frozen array of matching relative POSIX file paths.
 */
export function enumerateWorkspaceFilesSync(
  rootPath: string,
  globPattern: string | readonly string[],
): readonly string[] {
  const realRoot = realpathSync(path.resolve(rootPath));
  const visited = new Set<string>([realRoot]);
  const patternList = typeof globPattern === 'string' ? [globPattern] : globPattern;
  const isMatch = compileGlobOrExactMatcher(patternList);
  const rawMatches = globSync(patternList, {
    cwd: realRoot,
    dot: true,
    onlyFiles: true,
    ignore: ['**/.git/**', '**/node_modules/**'],
    fs: {
      readdirSync: ((dir: PathLike, opts?: unknown) => {
        const list = filterJailedDirents(realRoot, visited, String(dir), readdirSync(dir, { withFileTypes: true }));
        return typeof opts === 'object' && opts !== null ? list : list.map((d) => d.name);
      }) as FileSystemAdapter['readdirSync'],
    },
  });
  const matched: string[] = [];
  for (const entry of rawMatches) {
    const cleanRel = entry.replace(/\\/g, '/').replace(/\/+$/, '');
    if (isMatch(cleanRel)) matched.push(cleanRel);
  }
  matched.sort((a, b) => a.localeCompare(b));
  return Object.freeze(matched);
}

/**
 * Collects distinct mutated file paths from `observedEffects` and git working-tree changes since `baseRef`.
 *
 * Ensures `fs.regexCheck` inspects only files mutated during the session or since `scopeHandle.baseRef` (`SPEC.md` §4.3).
 *
 * @param {readonly ToolEffect[]} observedEffects - Tool effects recorded in `StepExecutionContext`.
 * @param {unknown}               scopeHandle     - Active isolation scope handle.
 *
 * @returns {readonly string[]} Sorted frozen array of distinct mutated worktree-relative POSIX paths.
 */
export function collectMutatedPathsSinceBaseRef(
  observedEffects: readonly ToolEffect[],
  scopeHandle: unknown,
): readonly string[] {
  const mutated = new Set<string>();
  for (const eff of observedEffects) {
    if (eff.kind !== 'fs:effect') continue;
    const mode = eff.attributes?.['mode'];
    if (eff.mutatesScope !== true && mode !== 'write') continue;
    const paths = eff.attributes?.['paths'];
    if (!Array.isArray(paths)) continue;
    for (const relPath of paths) {
      if (typeof relPath === 'string') mutated.add(relPath.replace(/\\/g, '/').replace(/^\.\//, ''));
    }
  }
  const { rootPath, baseRef } = extractWorktreeRootAndBaseRef(scopeHandle);
  let gitOutput = '';
  if (baseRef !== undefined && existsSync(path.join(rootPath, '.git'))) {
    try {
      const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CEILING_DIRECTORIES: path.dirname(rootPath) };
      const gitOpts = { cwd: rootPath, encoding: 'utf8' as const, stdio: 'pipe' as const, env: gitEnv };
      gitOutput = `${execFileSync('git', ['diff', '--name-only', baseRef], gitOpts)}\n${execFileSync('git', ['ls-files', '--others', '--exclude-standard'], gitOpts)}`;
    } catch {
      gitOutput = '';
    }
  }
  for (const line of gitOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) mutated.add(trimmed.replace(/\\/g, '/').replace(/^\.\//, ''));
  }
  return Object.freeze([...mutated].sort((a, b) => a.localeCompare(b)));
}
