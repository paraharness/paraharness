import { MemoryHarnessError } from '../memory-harness-error.js';
import {
  CONSECUTIVE_SLASHES_REGEX,
  LEADING_DOT_SLASH_REGEX,
  TRAILING_SLASHES_REGEX,
  WINDOWS_DRIVE_PREFIX_REGEX,
  WINDOWS_DRIVE_SLASH_REGEX,
} from './memory-protocol.constants.js';

/**
 * Normalizes `workspaceRoot` into a POSIX path without trailing slashes (unless equal to `'/'`).
 *
 * @param {string} workspaceRoot - Raw workspace root directory path.
 *
 * @returns {string} Normalized POSIX workspace root string.
 */
function normalizeWorkspaceRootPosix(workspaceRoot: string): string {
  const posix = workspaceRoot.trim().replaceAll('\\', '/').replace(CONSECUTIVE_SLASHES_REGEX, '/');
  if (posix === '/') return '/';
  const stripped = posix.replace(TRAILING_SLASHES_REGEX, '');
  return stripped.length === 0 ? '/' : stripped;
}

/**
 * Normalizes a single path or glob pattern into a workspace-relative POSIX pattern per §4.1.
 *
 * Strips `workspaceRoot`, converts `.` and `./` to the root globall pattern, and rejects empty
 * strings, `'..'` or `'.'` traversal segments, and absolute paths outside `workspaceRoot`.
 *
 * @param {string} rawPath       - Raw path or glob pattern to normalize.
 * @param {string} workspaceRoot - Absolute path to the workspace root directory.
 *
 * @returns {string} Normalized workspace-relative POSIX path or glob pattern.
 *
 * @throws {MemoryHarnessError} With `'VALIDATION_FAILED'` if `rawPath` is empty, traverses `'..'`, or lies outside `workspaceRoot`.
 */
export function normalizeMemoryPathPattern(rawPath: string, workspaceRoot: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      'Memory path or glob pattern must not be empty.',
      { rawPath },
    );
  }
  let normalized = trimmed.replaceAll('\\', '/').replace(CONSECUTIVE_SLASHES_REGEX, '/');
  const workspaceRootPosix = normalizeWorkspaceRootPosix(workspaceRoot);
  if (
    normalized === '.' ||
    normalized === './' ||
    normalized === workspaceRootPosix ||
    normalized === `${workspaceRootPosix}/`
  ) {
    return '**/*';
  }
  const rootPrefix = workspaceRootPosix === '/' ? '/' : `${workspaceRootPosix}/`;
  if (normalized.startsWith(rootPrefix)) {
    normalized = normalized.slice(rootPrefix.length);
  } else if (
    normalized.startsWith('/') ||
    WINDOWS_DRIVE_SLASH_REGEX.test(normalized) ||
    WINDOWS_DRIVE_PREFIX_REGEX.test(normalized)
  ) {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      `Path pattern '${rawPath}' is an absolute path outside workspaceRoot '${workspaceRoot}'.`,
      { rawPath, workspaceRoot },
    );
  }
  normalized = normalized.replace(LEADING_DOT_SLASH_REGEX, '').replace(TRAILING_SLASHES_REGEX, '');
  if (normalized === '' || normalized === '.') {
    return '**/*';
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.' || WINDOWS_DRIVE_PREFIX_REGEX.test(segment)) {
      throw new MemoryHarnessError(
        'VALIDATION_FAILED',
        `Path pattern '${rawPath}' contains forbidden segment '${segment}'.`,
        { rawPath, segment },
      );
    }
  }
  return normalized;
}

/**
 * Normalizes an array of path or glob strings via `normalizeMemoryPathPattern` and deduplicates
 * the resulting strings while preserving first-seen order (§4.1 Step 9).
 *
 * @param {readonly string[]} rawPaths      - Input path or glob strings to normalize.
 * @param {string}            workspaceRoot - Absolute path to the workspace root directory.
 *
 * @returns {readonly string[]} Frozen array of normalized, deduplicated POSIX paths/globs.
 *
 * @throws {MemoryHarnessError} With `'VALIDATION_FAILED'` if any entry fails `normalizeMemoryPathPattern`.
 */
export function normalizeMemoryPathArray(
  rawPaths: readonly string[],
  workspaceRoot: string,
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawPath of rawPaths) {
    const normalized = normalizeMemoryPathPattern(rawPath, workspaceRoot);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return Object.freeze(result);
}
