import { createHash } from 'node:crypto';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { execGitCommand } from './exec-git-command.js';
import {
  CONSECUTIVE_SLASHES_REGEX,
  LEADING_DOT_SLASH_REGEX,
  REPO_FILES_CACHE,
  TINYGLOBBY_IGNORE_PATTERNS,
  TRAILING_SLASHES_REGEX,
} from './memory-protocol.constants.js';

/**
 * Normalizes a relative file path entry into canonical POSIX form without leading `./` or trailing `/`.
 *
 * @param {string} rawEntry - Raw relative path returned by `git ls-files` or `tinyglobby`.
 *
 * @returns {string} Normalized POSIX relative path.
 */
function normalizeRepoFileEntry(rawEntry: string): string {
  return rawEntry
    .replaceAll('\\', '/')
    .replace(CONSECUTIVE_SLASHES_REGEX, '/')
    .replace(LEADING_DOT_SLASH_REGEX, '')
    .replace(TRAILING_SLASHES_REGEX, '');
}

/**
 * Parses null-delimited `git ls-files -s -z` output into sorted, deduplicated POSIX file paths.
 *
 * @param {string} stageOutput - Raw stdout from `git ls-files -s -z`.
 *
 * @returns {readonly string[]} Frozen sorted array of tracked relative file paths.
 */
function extractPathsFromLsFilesStage(stageOutput: string): readonly string[] {
  const seen = new Set<string>();
  const entries = stageOutput.split('\0');
  for (const entry of entries) {
    if (entry.length === 0) continue;
    const tabIdx = entry.indexOf('\t');
    const rawPath = tabIdx >= 0 ? entry.slice(tabIdx + 1) : entry;
    const normalized = normalizeRepoFileEntry(rawPath);
    if (normalized.length > 0) seen.add(normalized);
  }
  const sorted = [...seen].sort();
  return Object.freeze(sorted);
}

/**
 * Queries `git -C <workspaceRoot> ls-files -s -z` to obtain the current index state and tracked paths.
 *
 * @param {string} resolvedRoot - Resolved absolute path to the workspace root.
 *
 * @returns {Promise<string | null>} Raw `ls-files -s -z` output when inside a Git worktree, or `null` otherwise.
 */
async function runGitLsFilesStage(resolvedRoot: string): Promise<string | null> {
  const check = await execGitCommand({
    cwd: resolvedRoot,
    args: ['rev-parse', '--is-inside-work-tree'],
  });
  if (check.exitCode !== 0 || check.stdout.trim() !== 'true') return null;
  const result = await execGitCommand({
    cwd: resolvedRoot,
    args: ['ls-files', '-s', '-z'],
  });
  if (result.exitCode !== 0) return null;
  return result.stdout;
}

/**
 * Enumerates workspace files via `tinyglobby` when `workspaceRoot` is outside a Git worktree.
 *
 * @param {string} resolvedRoot - Resolved absolute path to the workspace root.
 *
 * @returns {Promise<readonly string[]>} Frozen sorted array of workspace-relative file paths.
 */
async function runTinyglobbyFallback(resolvedRoot: string): Promise<readonly string[]> {
  const matched = await glob(['**/*'], {
    cwd: resolvedRoot,
    dot: true,
    onlyFiles: true,
    ignore: [...TINYGLOBBY_IGNORE_PATTERNS],
  });
  const seen = new Set<string>();
  for (const rawPath of matched) {
    const normalized = normalizeRepoFileEntry(rawPath);
    if (normalized.length > 0) seen.add(normalized);
  }
  const sorted = [...seen].sort();
  return Object.freeze(sorted);
}

/**
 * Enumerates tracked workspace files via `git ls-files` cached per workspace tree state, falling
 * back to `tinyglobby` (`dot: true`, ignoring `.git`, `node_modules`, and `.memory/.session-state`)
 * when outside a Git worktree (§4.3).
 *
 * @param {string} workspaceRoot - Absolute path to the workspace root directory.
 *
 * @returns {Promise<readonly string[]>} Frozen array of normalized POSIX workspace-relative file paths.
 */
export async function listRepoFiles(workspaceRoot: string): Promise<readonly string[]> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const stageOutput = await runGitLsFilesStage(resolvedRoot);
  if (stageOutput !== null) {
    const treeKey = createHash('sha256').update(stageOutput, 'utf8').digest('hex');
    const cached = REPO_FILES_CACHE.get(resolvedRoot);
    if (cached !== undefined && cached.treeKey === treeKey) {
      return cached.files;
    }
    const files = extractPathsFromLsFilesStage(stageOutput);
    REPO_FILES_CACHE.set(resolvedRoot, Object.freeze({ treeKey, files }));
    return files;
  }
  REPO_FILES_CACHE.delete(resolvedRoot);
  return runTinyglobbyFallback(resolvedRoot);
}
