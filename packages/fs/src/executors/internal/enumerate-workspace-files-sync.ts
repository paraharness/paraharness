import { type PathLike, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { type FileSystemAdapter, globSync } from 'tinyglobby';
import { compileGlobOrExactMatcher } from './compile-glob-or-exact-matcher.js';
import { filterJailedDirents } from './filter-jailed-dirents.js';

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
  const visitedDirs = new Set<string>([realRoot]);
  const patternList = typeof globPattern === 'string' ? [globPattern] : globPattern;
  const isMatch = compileGlobOrExactMatcher(patternList);
  const rawMatches = globSync(patternList, {
    cwd: realRoot,
    dot: true,
    onlyFiles: true,
    ignore: ['**/.git/**', '**/node_modules/**'],
    fs: {
      readdirSync: ((dir: PathLike, opts?: unknown) => {
        const entries = filterJailedDirents({
          realRoot,
          visitedDirs,
          dirPath: String(dir),
          entries: readdirSync(dir, { withFileTypes: true }),
        });
        if (typeof opts === 'object' && opts !== null) return entries;
        const names: string[] = [];
        for (const entry of entries) names.push(entry.name);
        return names;
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
