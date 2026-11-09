import { isGlobPattern } from './is-glob-pattern.js';

/**
 * Extracts the longest leading directory prefix of `globPattern` that contains zero glob metacharacters (§4.2).
 *
 * Splits `globPattern` on `/`, collects leading static path segments, and joins them with `/`
 * (returning `''` when the first segment contains a glob metacharacter).
 *
 * @param {string} globPattern - Normalized POSIX glob pattern.
 *
 * @returns {string} Static directory prefix without trailing slash, or `''` when unrooted.
 */
export function extractStaticDirPrefix(globPattern: string): string {
  const segments = globPattern.split('/');
  const staticSegments: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || isGlobPattern(segment)) {
      break;
    }
    staticSegments.push(segment);
  }
  return staticSegments.join('/');
}
