import { type Dirent, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Parameters for {@link filterJailedDirents}.
 */
export interface FilterJailedDirentsParams {
  /** Canonicalized `realpathSync` root directory of the workspace. */
  readonly realRoot: string;

  /** Set of canonical directory paths already visited in this walk. */
  readonly visitedDirs: Set<string>;

  /** Current directory path being read by `tinyglobby`. */
  readonly dirPath: string;

  /** Raw directory entries returned by `fs.readdir`. */
  readonly entries: readonly Dirent[];
}

/**
 * Filters directory entries for `tinyglobby` so symlinks escaping `realRoot`, broken symlinks, and cycles are skipped.
 *
 * Enforces `realpathSync` containment inside `realRoot` and prevents cyclic directory symlink recursion.
 *
 * @param {FilterJailedDirentsParams} params - Canonical root, visited directory set, current directory, and raw dirents.
 *
 * @returns {Dirent[]} Filtered array of jailed directory entries.
 */
export function filterJailedDirents(params: FilterJailedDirentsParams): Dirent[] {
  let realDir: string;
  try {
    realDir = realpathSync(params.dirPath);
  } catch {
    return [];
  }
  const dirRel = path.relative(params.realRoot, realDir);
  if (
    dirRel === '..' ||
    dirRel.startsWith('../') ||
    dirRel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(dirRel)
  ) {
    return [];
  }
  const allowed: Dirent[] = [];
  for (const entry of params.entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    let realTarget: string;
    try {
      realTarget = realpathSync(path.join(params.dirPath, entry.name));
    } catch {
      continue;
    }
    const rel = path.relative(params.realRoot, realTarget);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      continue;
    }
    if (entry.isSymbolicLink() && statSync(realTarget).isDirectory()) {
      if (
        params.visitedDirs.has(realTarget) ||
        realDir === realTarget ||
        realDir.startsWith(`${realTarget}${path.sep}`)
      ) {
        continue;
      }
      params.visitedDirs.add(realTarget);
    }
    allowed.push(entry);
  }
  return allowed;
}
