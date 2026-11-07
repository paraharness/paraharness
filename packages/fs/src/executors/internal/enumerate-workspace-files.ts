import { type Dirent, readdir, realpathSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { compileGlobOrExactMatcher } from './compile-glob-or-exact-matcher.js';
import { filterJailedDirents } from './filter-jailed-dirents.js';

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
  const visitedDirs = new Set<string>([realRoot]);
  const patternList = typeof globPattern === 'string' ? [globPattern] : globPattern;
  const isMatch = compileGlobOrExactMatcher(patternList);
  const rawMatches = await glob(patternList, {
    cwd: realRoot,
    dot: true,
    onlyFiles: true,
    ignore: ['**/.git/**', '**/node_modules/**'],
    fs: {
      readdir: ((dir: string, _opts: unknown, cb?: (err: NodeJS.ErrnoException | null, files: Dirent[]) => void) => {
        readdir(dir, { withFileTypes: true }, (err, entries) =>
          cb?.(
            err,
            err !== null
              ? []
              : filterJailedDirents({ realRoot, visitedDirs, dirPath: String(dir), entries }),
          ),
        );
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
