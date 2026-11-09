import { extractStaticDirPrefix } from './extract-static-dir-prefix.js';
import {
  BRACE_GROUP_REGEX,
  DEFAULT_RELATIVE_PROBES,
  PROBE_FILE_SEGMENT,
  PROBE_SUBDIR_SEGMENT,
} from './memory-protocol.constants.js';

/**
 * Recursively expands brace groups (`{a,b}`) in `pattern` into flat pattern alternatives.
 *
 * @param {string} pattern - Glob pattern potentially containing brace expressions.
 *
 * @returns {readonly string[]} Expanded pattern strings without brace groups.
 */
function expandBraceAlternatives(pattern: string): readonly string[] {
  const match = BRACE_GROUP_REGEX.exec(pattern);
  if (match === null || match.index === undefined) {
    return [pattern];
  }
  const fullMatch = match[0];
  const inner = match[1] ?? '';
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + fullMatch.length);
  const options = inner.split(',');
  const expanded: string[] = [];
  for (const option of options) {
    for (const tail of expandBraceAlternatives(`${prefix}${option}${suffix}`)) {
      expanded.push(tail);
    }
  }
  return expanded;
}

/**
 * Replaces glob metacharacter tokens in a single non-`'**'` path segment with synthetic probe strings.
 *
 * @param {string} segment - Single path segment from a split glob pattern.
 *
 * @returns {readonly string[]} Synthetic probe segment variants.
 */
function buildSegmentProbes(segment: string): readonly string[] {
  const primary = segment
    .replace(/[@+*?!]\([^)]*\)/gu, PROBE_FILE_SEGMENT)
    .replace(/\[[^\]]*\]/gu, PROBE_FILE_SEGMENT)
    .replace(/[*?]+/gu, PROBE_FILE_SEGMENT)
    .replace(/^!+/u, '');
  const variants = new Set<string>();
  variants.add(primary.length > 0 ? primary : PROBE_FILE_SEGMENT);
  if (segment.includes('?') || segment.includes('[')) {
    const singleCharVariant = segment
      .replace(/[@+*?!]\([^)]*\)/gu, 'a')
      .replace(/\[\^?![^\]]*\]/gu, 'z')
      .replace(/\[([^\]]+)\]/gu, (_m, chars: string) => chars[0] ?? 'a')
      .replace(/\?/gu, 'a')
      .replace(/\*+/gu, PROBE_FILE_SEGMENT)
      .replace(/^!+/u, '');
    if (singleCharVariant.length > 0) {
      variants.add(singleCharVariant);
    }
  }
  return [...variants];
}

/**
 * Expands a single brace-free sub-pattern segment list into relative probe paths, replacing each
 * `'**'` segment with both zero segments (`[]`) and one segment (`['__sub__']`).
 *
 * @param {readonly string[]} segments - Split POSIX path segments of the sub-pattern.
 *
 * @returns {readonly string[]} Generated relative probe strings for `segments`.
 */
function expandSegmentsToProbes(segments: readonly string[]): readonly string[] {
  let prefixes: string[][] = [[]];
  for (const segment of segments) {
    if (segment.length === 0) continue;
    const nextPrefixes: string[][] = [];
    if (segment === '**') {
      for (const current of prefixes) {
        nextPrefixes.push([...current]);
        nextPrefixes.push([...current, PROBE_SUBDIR_SEGMENT]);
      }
    } else {
      const segVariants = buildSegmentProbes(segment);
      for (const current of prefixes) {
        for (const variant of segVariants) {
          nextPrefixes.push([...current, variant]);
        }
      }
    }
    prefixes = nextPrefixes;
  }
  const results: string[] = [];
  for (const parts of prefixes) {
    if (parts.length > 0) {
      results.push(parts.join('/'));
    }
  }
  return results;
}

/**
 * Constructs synthetic relative probe paths segment-wise for `pattern` (§4.3, §5.2).
 *
 * Takes both the sub-pattern after `extractStaticDirPrefix(pattern)` and the full `pattern`,
 * expands brace alternatives (`{a,b}`), replaces each `'**'` segment with `[]` and `['__sub__']`,
 * replaces remaining glob metacharacter tokens with `'__probe__'`, and always includes
 * `'__probe__'` and `'__sub__/__probe__'` in the returned deduplicated list.
 *
 * @param {string} pattern - Normalized POSIX path or glob pattern.
 *
 * @returns {readonly string[]} Frozen deduplicated list of relative probe paths.
 */
export function buildRelativeProbes(pattern: string): readonly string[] {
  const staticPrefix = extractStaticDirPrefix(pattern);
  const subPattern =
    staticPrefix.length === 0
      ? pattern
      : pattern === staticPrefix
        ? ''
        : pattern.slice(staticPrefix.length + 1);
  const candidatePatterns =
    subPattern.length > 0 && subPattern !== pattern ? [subPattern, pattern] : [pattern];
  const probes = new Set<string>();
  for (const rawCandidate of candidatePatterns) {
    for (const expanded of expandBraceAlternatives(rawCandidate)) {
      for (const probe of expandSegmentsToProbes(expanded.split('/'))) {
        if (probe.length > 0) {
          probes.add(probe);
        }
      }
    }
  }
  for (const fallbackProbe of DEFAULT_RELATIVE_PROBES) {
    probes.add(fallbackProbe);
  }
  return Object.freeze([...probes]);
}
