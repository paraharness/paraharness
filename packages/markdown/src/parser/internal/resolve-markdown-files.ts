import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import picomatch from 'picomatch';
import { glob } from 'tinyglobby';

/**
 * Resolves a host-root-relative file path or glob pattern into sorted relative POSIX paths.
 *
 * Uses `tinyglobby` and `picomatch` when glob tokens are present or expands directory paths to `**\/*.md`.
 *
 * @param {string} hostRoot   - Absolute host repository root path.
 * @param {string} pathOrGlob - Relative path or glob pattern to resolve.
 *
 * @returns {Promise<readonly string[]>} Sorted array of matched relative POSIX file paths.
 */
export async function resolveMarkdownFiles(
  hostRoot: string,
  pathOrGlob: string,
): Promise<readonly string[]> {
  let cleanPattern = pathOrGlob.replace(/\\/g, '/').replace(/^\.\//, '');
  const initialScan = picomatch.scan(cleanPattern);
  if (!initialScan.isGlob && !initialScan.negated) {
    const absPath = resolve(hostRoot, cleanPattern);
    const targetStat = await stat(absPath);
    if (targetStat.isFile()) return Object.freeze([cleanPattern]);
    if (!targetStat.isDirectory()) {
      throw new Error(`Markdown path '${pathOrGlob}' is not a regular file.`);
    }
    cleanPattern = `${cleanPattern.replace(/\/+$/, '')}/**/*.md`;
  }
  const activeScan = picomatch.scan(cleanPattern);
  const isAbs = cleanPattern.startsWith('/');
  let searchCwd = hostRoot;
  if (isAbs) {
    searchCwd = activeScan.base.length > 0 ? activeScan.base : '/';
  }
  if (!existsSync(searchCwd)) return Object.freeze([]);
  const relGlob = isAbs ? posix.relative(searchCwd, cleanPattern) : cleanPattern;
  const rawEntries = await glob(relGlob, {
    cwd: searchCwd,
    dot: true,
    onlyFiles: true,
    ignore: ['**/.git/**', '**/node_modules/**'],
  });
  const isMatch = picomatch(cleanPattern, { dot: true });
  const matched: string[] = [];
  for (const entry of rawEntries) {
    const cleanEntry = entry.replace(/\\/g, '/').replace(/\/+$/, '');
    const candidate = isAbs ? posix.join(searchCwd, cleanEntry) : cleanEntry;
    if (isMatch(candidate)) matched.push(candidate);
  }
  matched.sort((a, b) => a.localeCompare(b));
  return Object.freeze(matched);
}
